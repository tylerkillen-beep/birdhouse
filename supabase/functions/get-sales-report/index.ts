// Supabase Edge Function: get-sales-report
// Fetches sales data from Square Payments API + Supabase orders table.
//
// Square Payments API provides accurate revenue totals (source of truth).
// Supabase orders table (cart_items JSONB) provides the per-item breakdown.
//
// Required Supabase secrets:
//   SQUARE_ACCESS_TOKEN  — access token from Square Developer Dashboard
//   SQUARE_LOCATION_ID   — your Square location ID
//
// Request body: { startDate: ISO8601 string, endDate: ISO8601 string }
// Accessible by any authenticated student, manager, or admin.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function getSquareBaseUrl() {
  const env = (Deno.env.get("SQUARE_ENV") || "production").toLowerCase();
  if (env === "sandbox") return "https://connect.squareupsandbox.com";
  return "https://connect.squareup.com";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

interface SquarePayment {
  id: string;
  created_at: string;
  status: string;
  amount_money?: { amount: number; currency: string };
}

interface CartItem {
  name: string;
  quantity: number;
  price: number;
  temp?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anon || !service) {
      return json({ success: false, error: "Missing Supabase environment variables" }, 500);
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anon, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ success: false, error: "Unauthorized" }, 401);

    const email = (user.email || "").toLowerCase();
    const serviceClient = createClient(supabaseUrl, service);

    let allowed = email === "tylerkillen@nixaschools.net";
    if (!allowed) {
      const { data: student } = await serviceClient
        .from("students")
        .select("role")
        .eq("id", user.id)
        .single();
      allowed = !!student;
    }

    if (!allowed) return json({ success: false, error: "Forbidden — staff access only" }, 403);

    // ── Parse request ─────────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const { startDate, endDate } = body as { startDate?: string; endDate?: string };

    if (!startDate || !endDate) {
      return json({ success: false, error: "startDate and endDate are required (ISO 8601)" }, 400);
    }

    const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
    const locationId = Deno.env.get("SQUARE_LOCATION_ID");

    if (!squareToken || !locationId) {
      return json({ success: false, error: "Square credentials not configured — contact admin" }, 500);
    }

    // ── Fetch payments from Square Payments API (paginated) ───────────────────
    // Uses /v2/payments since process-payment creates payments directly (not orders).
    const squareBaseUrl = getSquareBaseUrl();
    const squareHeaders = {
      "Authorization": `Bearer ${squareToken}`,
      "Square-Version": "2024-01-18",
    };

    const allPayments: SquarePayment[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({
        begin_time: startDate,
        end_time: endDate,
        location_id: locationId,
        limit: "100",
        sort_order: "ASC",
      });
      if (cursor) params.set("cursor", cursor);

      const sqRes = await fetch(`${squareBaseUrl}/v2/payments?${params.toString()}`, {
        headers: squareHeaders,
      });

      const sqBody = await sqRes.json();

      if (!sqRes.ok || sqBody?.errors?.length) {
        const errDetail = sqBody?.errors?.[0]?.detail || sqBody?.errors?.[0]?.code || JSON.stringify(sqBody);
        return json({ success: false, error: `Square API error: ${errDetail}` }, 400);
      }

      const payments: SquarePayment[] = sqBody.payments || [];
      // Only count completed payments
      allPayments.push(...payments.filter(p => p.status === "COMPLETED"));
      cursor = sqBody.cursor || undefined;
    } while (cursor);

    // ── Aggregate revenue from Square payments ────────────────────────────────
    let totalRevenueCents = 0;
    const dailyMap: Record<string, { revenueCents: number; orderCount: number }> = {};

    for (const payment of allPayments) {
      const amount = payment.amount_money?.amount ?? 0;
      totalRevenueCents += amount;

      const day = payment.created_at.slice(0, 10); // YYYY-MM-DD
      if (!dailyMap[day]) dailyMap[day] = { revenueCents: 0, orderCount: 0 };
      dailyMap[day].revenueCents += amount;
      dailyMap[day].orderCount += 1;
    }

    // ── Fetch item breakdown from Supabase orders table ───────────────────────
    // cart_items JSONB has the per-item detail that Square Payments API doesn't provide.
    const { data: orders } = await serviceClient
      .from("orders")
      .select("cart_items, total_amount, created_at")
      .gte("created_at", startDate)
      .lte("created_at", endDate)
      .eq("status", "paid");

    const itemMap: Record<string, { quantity: number; revenueCents: number }> = {};

    for (const order of orders || []) {
      const items: CartItem[] = Array.isArray(order.cart_items) ? order.cart_items : [];
      for (const item of items) {
        const name = item.name || "Unknown Item";
        const qty = Number(item.quantity) || 1;
        const rev = Math.round((item.price || 0) * qty * 100);
        if (!itemMap[name]) itemMap[name] = { quantity: 0, revenueCents: 0 };
        itemMap[name].quantity += qty;
        itemMap[name].revenueCents += rev;
      }
    }

    const topItems = Object.entries(itemMap)
      .map(([name, d]) => ({ name, quantity: d.quantity, revenueCents: d.revenueCents }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10);

    const dailyBreakdown = Object.entries(dailyMap)
      .map(([date, d]) => ({ date, revenueCents: d.revenueCents, orderCount: d.orderCount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const orderCount = allPayments.length;
    const avgOrderValueCents = orderCount > 0 ? Math.round(totalRevenueCents / orderCount) : 0;

    return json({
      success: true,
      orderCount,
      totalRevenueCents,
      totalRevenue: (totalRevenueCents / 100).toFixed(2),
      avgOrderValueCents,
      avgOrderValue: (avgOrderValueCents / 100).toFixed(2),
      topItems,
      dailyBreakdown,
    });
  } catch (e) {
    console.error("get-sales-report error:", e);
    return json({ success: false, error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
