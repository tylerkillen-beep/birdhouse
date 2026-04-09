// Supabase Edge Function: process-payment
// Handles Square payments for multi-item Birdhouse orders.
//
// Required Supabase secrets (set via: supabase secrets set KEY=value):
//   SQUARE_ACCESS_TOKEN  — access token from Square Developer Dashboard (matches environment)
//   SQUARE_LOCATION_ID   — your Square location ID (matches environment)
//
// The function receives the Square card token from the frontend, charges the
// card for the full cart total (minus any loyalty credit applied), records the
// order in the `orders` table, and updates the customer's loyalty metadata.
//
// Loyalty system:
//   - $25 spent on menu orders (non-subscription) earns a $3 credit
//   - Credits accumulate; multiple can be used at once
//   - Subscriptions are excluded from earning and using credits
//   - User metadata fields: loyalty_spend_cents (cumulative), loyalty_credit_cents (available)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

// Loyalty constants
const SPEND_THRESHOLD_CENTS = 2500; // $25.00
const CREDIT_REWARD_CENTS   = 300;  // $3.00

function getSquareBaseUrl() {
  const env = (Deno.env.get("SQUARE_ENV") || "production").toLowerCase();
  if (env === "sandbox") return "https://connect.squareupsandbox.com";
  return "https://connect.squareup.com";
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

function fail(message: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

function normalizeEmail(email: string | null | undefined) {
  const normalized = (email || "").trim().toLowerCase();
  return normalized || null;
}


function getBearerToken(req: Request) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { sourceId, cartItems, userId, customerInfo, creditUsedCents: rawCreditUsed, deliveryMethod } = await req.json();

    // ── Validate auth ──────────────────────────────────────────────────────
    const accessToken = getBearerToken(req);
    if (!accessToken) return fail("Authentication required", 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      return fail("Invalid or expired session. Please sign in again.", 401);
    }

    const isAnonymousUser = (user as { is_anonymous?: boolean }).is_anonymous === true;
    if (isAnonymousUser) {
      return fail("Please sign in before placing an order.", 401);
    }

    // Prefer authenticated email, with customer payload as a fallback.
    // Square only sends receipt emails when buyer_email_address is present.
    let buyerEmail = normalizeEmail(user.email) || normalizeEmail(customerInfo?.email);

    // Some auth flows can yield sparse user payloads from getUser(token).
    // If email is still missing, hydrate directly from auth by user id.
    if (!buyerEmail) {
      const { data: adminUserData, error: adminUserError } = await supabase.auth.admin.getUserById(user.id);
      if (adminUserError) {
        console.warn("process-payment: unable to hydrate auth user email", {
          userId,
          error: adminUserError.message,
        });
      }
      buyerEmail = normalizeEmail(adminUserData.user?.email);
    }

    // ── Validate inputs ────────────────────────────────────────────────────
    if (!sourceId) throw new Error("Missing payment token");
    if (!cartItems?.length) throw new Error("Cart is empty");
    if (!userId) throw new Error("User not authenticated");
    if (user.id !== userId) return fail("User mismatch", 403);
    if (!customerInfo?.room) throw new Error("Delivery location is required");

    const orderDeliveryMethod = (deliveryMethod === 'pickup') ? 'pickup' : 'delivery';

    // Students pay $1 for delivery; teachers always get free delivery
    const isTeacherEmail = (user.email || '').endsWith('@nixaschools.net');
    const deliveryFeeCents = (!isTeacherEmail && orderDeliveryMethod === 'delivery') ? 100 : 0;

    // ── Calculate order total ──────────────────────────────────────────────
    interface CartItem {
      id: string;
      name: string;
      temp: "hot" | "iced";
      price: number;
      quantity: number;
    }

    const items: CartItem[] = cartItems;
    const itemsTotalCents = Math.round(
      items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100
    );
    const orderTotalCents = itemsTotalCents + deliveryFeeCents;

    if (orderTotalCents <= 0) throw new Error("Order total must be greater than zero");

    // ── Validate and apply loyalty credit ─────────────────────────────────
    // Read authoritative loyalty state from the profiles table.  user_metadata
    // can be stale or absent for accounts that predate the loyalty system;
    // profiles is the canonical source kept in sync by this function and
    // backfilled from historical orders via migration.
    const meta = user.user_metadata || {};
    const { data: profileLoyalty } = await supabase
      .from("profiles")
      .select("loyalty_spend_cents, loyalty_credit_cents")
      .eq("id", user.id)
      .maybeSingle();

    const availableCreditCents: number =
      profileLoyalty?.loyalty_credit_cents ?? meta.loyalty_credit_cents ?? 0;

    const creditUsedCents = Math.max(0, Math.min(
      Math.round(rawCreditUsed || 0),
      availableCreditCents,
      orderTotalCents
    ));

    const chargeAmountCents = orderTotalCents - creditUsedCents;

    // ── Charge via Square (skip if fully covered by credit) ────────────────
    let squarePaymentId: string | null = null;

    if (chargeAmountCents > 0) {
      const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
      const locationId = Deno.env.get("SQUARE_LOCATION_ID");

      if (!squareToken || !locationId) {
        throw new Error("Square credentials not configured — contact admin");
      }

      const squareBaseUrl = getSquareBaseUrl();

      if (!buyerEmail) {
        console.warn("process-payment: buyer email missing; proceeding without Square receipt email", {
          userId,
          squareEnv: Deno.env.get("SQUARE_ENV") || "production",
        });
      }

      const squareRes = await fetch(`${squareBaseUrl}/v2/payments`, {
        method: "POST",
        headers: {
          "Square-Version": "2024-01-18",
          "Authorization": `Bearer ${squareToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_id: sourceId,
          idempotency_key: crypto.randomUUID(),
          amount_money: { amount: chargeAmountCents, currency: "USD" },
          location_id: locationId,
          ...(buyerEmail ? { buyer_email_address: buyerEmail } : {}),
          note: `Birdhouse — ${customerInfo.customerName} — ${orderDeliveryMethod === 'pickup' ? 'Pickup' : `Room ${customerInfo.room}`}`,
        }),
      });

      const squareData = await squareRes.json();

      if (!squareRes.ok || squareData.errors?.length) {
        const err = squareData.errors?.[0];
        console.error("Square payment error:", {
          category: err?.category,
          code: err?.code,
          detail: err?.detail,
          field: err?.field,
          squareEnv: Deno.env.get("SQUARE_ENV") || "production",
          locationId,
        });

        if (err?.category === "AUTHENTICATION_ERROR") {
          throw new Error(
            "Square credentials are misconfigured. Check SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, and SQUARE_ENV in Supabase secrets."
          );
        }

        throw new Error(err?.detail ?? "Payment declined");
      }

      squarePaymentId = squareData.payment.id;
    }

    // ── Insert order into Supabase ─────────────────────────────────────────
    const totalAmount = orderTotalCents / 100;

    const drinkName =
      items.length === 1
        ? `${items[0].name} (${items[0].temp === "iced" ? "Iced" : "Hot"})`
        : `${items[0].name} + ${items.length - 1} more item${items.length > 2 ? "s" : ""}`;

    const itemName = items.map(i => i.name).join(', ');

    const { data: order, error: dbError } = await supabase
      .from("orders")
      .insert({
        user_id: userId,
        customer_name: customerInfo.customerName || null,
        drink_name: drinkName,
        item_name: itemName,
        cart_items: items,
        total_amount: totalAmount,
        room: customerInfo.room,
        delivery_day: customerInfo.deliveryDay,
        delivery_date: customerInfo.deliveryDate || null,
        delivery_time: customerInfo.deliveryTime,
        special_instructions: customerInfo.notes || null,
        customer_location: customerInfo.customerLocation || null,
        status: "paid",
        points_earned: 0,
        credit_used_cents: creditUsedCents,
        square_payment_id: squarePaymentId,
        delivery_method: orderDeliveryMethod,
      })
      .select()
      .single();

    if (dbError) {
      console.error("DB insert failed after successful payment:", dbError, {
        squarePaymentId,
        userId,
        totalAmount,
      });
      // Still update loyalty even if order record fails
    }

    // ── Update loyalty metadata ────────────────────────────────────────────
    // Spend tracks the full order total (pre-credit) so using credits doesn't
    // slow down future earning.  Use the profiles value (authoritative) as the
    // baseline so historical orders are counted correctly.
    const oldSpendCents: number =
      profileLoyalty?.loyalty_spend_cents ?? meta.loyalty_spend_cents ?? 0;
    const newSpendCents = oldSpendCents + orderTotalCents;

    const creditsAlreadyEarned = Math.floor(oldSpendCents / SPEND_THRESHOLD_CENTS) * CREDIT_REWARD_CENTS;
    const creditsNowEarned     = Math.floor(newSpendCents / SPEND_THRESHOLD_CENTS) * CREDIT_REWARD_CENTS;
    const newCreditsAwarded    = creditsNowEarned - creditsAlreadyEarned;

    const newCreditBalance = Math.max(0, availableCreditCents - creditUsedCents + newCreditsAwarded);

    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...meta,
        loyalty_spend_cents:  newSpendCents,
        loyalty_credit_cents: newCreditBalance,
        // Clear old points field so the UI doesn't show stale data
        loyalty_points: undefined,
      },
    });

    // Sync loyalty totals to profiles table so the admin panel can display them
    await supabase
      .from("profiles")
      .upsert(
        { id: userId, loyalty_spend_cents: newSpendCents, loyalty_credit_cents: newCreditBalance },
        { onConflict: "id" }
      );

    return ok({
      success: true,
      orderId: order?.id ?? null,
      ...(dbError ? { warning: "Payment accepted — order may take a moment to appear. Contact staff if it doesn't." } : {}),
      loyaltyUpdate: {
        newSpendCents,
        newCreditBalance,
        newCreditsAwarded,
      },
    });
  } catch (err) {
    console.error("process-payment error:", err);
    return fail(err instanceof Error ? err.message : "An unexpected error occurred");
  }
});
