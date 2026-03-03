// Supabase Edge Function: process-payment
// Handles Square sandbox payments for multi-item Birdhouse orders.
//
// Required Supabase secrets (set via: supabase secrets set KEY=value):
//   SQUARE_ACCESS_TOKEN  — sandbox access token from Square Developer Dashboard
//   SQUARE_LOCATION_ID   — your Square sandbox location ID
//
// The function receives the Square card token from the frontend, charges the
// card for the full cart total, then records the order in the `orders` table.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

function fail(message: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { sourceId, cartItems, userId, customerInfo } = await req.json();

    // ── Validate inputs ────────────────────────────────────────────────────
    if (!sourceId) throw new Error("Missing payment token");
    if (!cartItems?.length) throw new Error("Cart is empty");
    if (!userId) throw new Error("User not authenticated");
    if (!customerInfo?.room) throw new Error("Delivery room is required");

    // ── Calculate total ────────────────────────────────────────────────────
    interface CartItem {
      id: string;
      name: string;
      temp: "hot" | "iced";
      price: number;
      quantity: number;
    }

    const items: CartItem[] = cartItems;
    const totalCents = Math.round(
      items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100
    );

    if (totalCents <= 0) throw new Error("Order total must be greater than zero");

    // ── Charge via Square sandbox ──────────────────────────────────────────
    const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
    const locationId = Deno.env.get("SQUARE_LOCATION_ID");

    if (!squareToken || !locationId) {
      throw new Error("Square credentials not configured — contact admin");
    }

    const squareRes = await fetch("https://connect.squareupsandbox.com/v2/payments", {
      method: "POST",
      headers: {
        "Square-Version": "2024-01-18",
        "Authorization": `Bearer ${squareToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: crypto.randomUUID(),
        amount_money: { amount: totalCents, currency: "USD" },
        location_id: locationId,
        note: `Birdhouse — ${customerInfo.customerName} — Room ${customerInfo.room}`,
      }),
    });

    const squareData = await squareRes.json();

    if (!squareRes.ok || squareData.errors?.length) {
      const detail = squareData.errors?.[0]?.detail ?? "Payment declined";
      throw new Error(detail);
    }

    const squarePaymentId: string = squareData.payment.id;

    // ── Insert order into Supabase ─────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const totalAmount = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const pointsEarned = items.reduce((s, i) => s + i.quantity, 0);

    // Human-readable summary name for the order (used in legacy single-drink display)
    const drinkName =
      items.length === 1
        ? `${items[0].name} (${items[0].temp === "iced" ? "Iced" : "Hot"})`
        : `${items[0].name} + ${items.length - 1} more item${items.length > 2 ? "s" : ""}`;

    const { data: order, error: dbError } = await supabase
      .from("orders")
      .insert({
        user_id: userId,
        drink_name: drinkName,
        cart_items: items,
        total_amount: totalAmount,
        room: customerInfo.room,
        delivery_day: customerInfo.deliveryDay,
        delivery_time: customerInfo.deliveryTime,
        special_instructions: customerInfo.notes || null,
        status: "paid",
        points_earned: pointsEarned,
        square_payment_id: squarePaymentId,
      })
      .select()
      .single();

    if (dbError) {
      // Payment went through but the DB write failed.
      // Log it so the admin can reconcile via Square dashboard.
      console.error("DB insert failed after successful payment:", dbError, {
        squarePaymentId,
        userId,
        totalAmount,
      });
      return ok({
        success: true,
        orderId: null,
        warning: "Payment accepted — order may take a moment to appear. Contact staff if it doesn't.",
      });
    }

    return ok({ success: true, orderId: order.id });
  } catch (err) {
    console.error("process-payment error:", err);
    return fail(err instanceof Error ? err.message : "An unexpected error occurred");
  }
});
