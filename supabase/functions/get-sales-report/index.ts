// Supabase Edge Function: get-sales-report
// Fetches sales data from Square Payments API + Square Orders API + Supabase orders table.
//
// Revenue source of truth: Square Payments API (/v2/payments)
// Item detail — Square POS/Online sales: Square Orders API (/v2/orders/search) line_items
// Item detail — Birdhouse App sales: Supabase orders.cart_items JSONB
//   (App payments only send the dollar amount to Square, not line items.
//    Square auto-creates a shadow order with no line items for these payments.
//    We skip those shadow orders and use cart_items from Supabase instead.)
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
  order_id?: string;
  amount_money?: { amount: number; currency: string };
  processing_fee?: Array<{ amount_money?: { amount: number; currency: string } }>;
}

interface SquareLineItem {
  name?: string;
  quantity?: string;
  total_money?: { amount: number; currency: string };
  total_discount_money?: { amount: number; currency: string };
  variation_name?: string;
}

interface SquareOrder {
  id: string;
  state: string;
  created_at: string;
  source?: { name?: string };
  line_items?: SquareLineItem[];
}

interface CartItem {
  name: string;
  quantity: number;
  price: number;
  temp?: string;
}

async function fetchSquareOrders(
  baseUrl: string,
  headers: Record<string, string>,
  locationId: string,
  startDate: string,
  endDate: string,
): Promise<SquareOrder[]> {
  const allOrders: SquareOrder[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      location_ids: [locationId],
      query: {
        filter: {
          date_time_filter: {
            created_at: { start_at: startDate, end_at: endDate },
          },
          state_filter: { states: ["COMPLETED"] },
        },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;

    const res = await fetch(`${baseUrl}/v2/orders/search`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok || data?.errors?.length) {
      console.warn("Square Orders API error:", JSON.stringify(data?.errors?.[0] || data));
      break;
    }

    allOrders.push(...(data.orders || []));
    cursor = data.cursor || undefined;
  } while (cursor);

  return allOrders;
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

    const squareBaseUrl = getSquareBaseUrl();
    const squareHeaders = {
      "Authorization": `Bearer ${squareToken}`,
      "Square-Version": "2024-01-18",
    };

    // ── Fetch payments from Square Payments API (revenue source of truth) ─────
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
      allPayments.push(...payments.filter(p => p.status === "COMPLETED"));
      cursor = sqBody.cursor || undefined;
    } while (cursor);

    // ── Aggregate revenue from Square payments ────────────────────────────────
    let totalRevenueCents = 0;
    let totalProcessingFeeCents = 0;
    const dailyMap: Record<string, { revenueCents: number; orderCount: number }> = {};

    for (const payment of allPayments) {
      const amount = payment.amount_money?.amount ?? 0;
      totalRevenueCents += amount;

      for (const fee of payment.processing_fee || []) {
        totalProcessingFeeCents += fee.amount_money?.amount ?? 0;
      }

      const day = payment.created_at.slice(0, 10); // YYYY-MM-DD
      if (!dailyMap[day]) dailyMap[day] = { revenueCents: 0, orderCount: 0 };
      dailyMap[day].revenueCents += amount;
      dailyMap[day].orderCount += 1;
    }

    // ── Fetch Birdhouse App orders from Supabase ──────────────────────────────
    // Include all active statuses so items for in-progress/delivered orders are counted.
    // App payments only send the dollar amount to Square — line items live in cart_items.
    const { data: appOrders } = await serviceClient
      .from("orders")
      .select("id, cart_items, total_amount, created_at, square_payment_id")
      .gte("created_at", startDate)
      .lte("created_at", endDate)
      .in("status", ["paid", "preparing", "ready", "delivered"]);

    // Set of Square payment IDs that originated from the Birdhouse App.
    const birdhousePaymentIds = new Set<string>(
      (appOrders || []).map((o: { square_payment_id: string | null }) => o.square_payment_id).filter(Boolean)
    );

    // Map Square order_id → Square payment_id so we can identify shadow orders.
    // When process-payment charges a bare payment, Square auto-creates an order with no
    // line items. We detect these by matching the payment ID to a known app payment.
    const paymentIdBySquareOrderId: Record<string, string> = {};
    for (const payment of allPayments) {
      if (payment.order_id) paymentIdBySquareOrderId[payment.order_id] = payment.id;
    }

    // ── Fetch item detail from Square Orders API (POS / Square Online only) ───
    const squareOrders = await fetchSquareOrders(squareBaseUrl, squareHeaders, locationId, startDate, endDate);

    const itemMap: Record<string, { quantity: number; revenueCents: number; discountCents: number }> = {};

    for (const order of squareOrders) {
      // Skip shadow orders auto-created by Square for Birdhouse App payments.
      // These have no real line items and would appear as "Unknown Item".
      const matchedPaymentId = paymentIdBySquareOrderId[order.id];
      if (matchedPaymentId && birdhousePaymentIds.has(matchedPaymentId)) continue;

      for (const lineItem of order.line_items || []) {
        const name = lineItem.name || "Unknown Item";
        const qty = parseInt(lineItem.quantity || "1", 10);
        const rev = lineItem.total_money?.amount ?? 0;
        const disc = lineItem.total_discount_money?.amount ?? 0;
        if (!itemMap[name]) itemMap[name] = { quantity: 0, revenueCents: 0, discountCents: 0 };
        itemMap[name].quantity += qty;
        itemMap[name].revenueCents += rev;
        itemMap[name].discountCents += disc;
      }
    }

    // ── Classify Square payments as In-Store vs Square Online vs Birdhouse App ─
    const squareOrderSourceMap: Record<string, 'online' | 'instore'> = {};
    for (const order of squareOrders) {
      const matchedPaymentId = paymentIdBySquareOrderId[order.id];
      if (matchedPaymentId && birdhousePaymentIds.has(matchedPaymentId)) continue;
      const name = (order.source?.name || '').toLowerCase();
      squareOrderSourceMap[order.id] = name.includes('online') ? 'online' : 'instore';
    }

    const dailyInStoreMap: Record<string, { revenueCents: number; orderCount: number }> = {};
    const dailyOnlineMap: Record<string, { revenueCents: number; orderCount: number }> = {};
    const inAppDailyMap: Record<string, { revenueCents: number; orderCount: number }> = {};

    for (const payment of allPayments) {
      const amount = payment.amount_money?.amount ?? 0;
      const day = payment.created_at.slice(0, 10);

      if (birdhousePaymentIds.has(payment.id)) {
        // Birdhouse App payment — revenue already totalled above, just track daily split
        if (!inAppDailyMap[day]) inAppDailyMap[day] = { revenueCents: 0, orderCount: 0 };
        inAppDailyMap[day].revenueCents += amount;
        inAppDailyMap[day].orderCount += 1;
      } else {
        const src = payment.order_id ? squareOrderSourceMap[payment.order_id] : undefined;
        if (src === 'online') {
          if (!dailyOnlineMap[day]) dailyOnlineMap[day] = { revenueCents: 0, orderCount: 0 };
          dailyOnlineMap[day].revenueCents += amount;
          dailyOnlineMap[day].orderCount += 1;
        } else if (src === 'instore') {
          if (!dailyInStoreMap[day]) dailyInStoreMap[day] = { revenueCents: 0, orderCount: 0 };
          dailyInStoreMap[day].revenueCents += amount;
          dailyInStoreMap[day].orderCount += 1;
        }
      }
    }

    // Credit-only app orders ($0 Square charge, square_payment_id is null) still need
    // to appear in the in-app daily count.
    for (const order of appOrders || []) {
      if (order.square_payment_id) continue; // already counted via Square payment above
      const orderRevCents = Math.round((order.total_amount || 0) * 100);
      const day = (order.created_at as string).slice(0, 10);
      if (!inAppDailyMap[day]) inAppDailyMap[day] = { revenueCents: 0, orderCount: 0 };
      inAppDailyMap[day].revenueCents += orderRevCents;
      inAppDailyMap[day].orderCount += 1;
    }

    // ── Aggregate item detail from Supabase cart_items (Birdhouse App orders) ─
    for (const order of appOrders || []) {
      const items: CartItem[] = Array.isArray(order.cart_items) ? order.cart_items : [];
      for (const item of items) {
        const name = item.name || "Unknown Item";
        const qty = Number(item.quantity) || 1;
        const rev = Math.round((item.price || 0) * qty * 100);
        if (!itemMap[name]) itemMap[name] = { quantity: 0, revenueCents: 0, discountCents: 0 };
        itemMap[name].quantity += qty;
        itemMap[name].revenueCents += rev;
        // In-app orders don't carry Square discount data; discountCents stays 0
      }
    }

    // Prorate processing fees to each item by its share of total revenue
    const topItems = Object.entries(itemMap)
      .map(([name, d]) => {
        const processingFeeCents = totalRevenueCents > 0
          ? Math.round(totalProcessingFeeCents * d.revenueCents / totalRevenueCents)
          : 0;
        return { name, quantity: d.quantity, revenueCents: d.revenueCents, discountCents: d.discountCents, processingFeeCents };
      })
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 50);

    const totalDiscountCents = Object.values(itemMap).reduce((s, d) => s + d.discountCents, 0);

    const dailyBreakdown = Object.entries(dailyMap)
      .map(([date, d]) => {
        const inApp = inAppDailyMap[date] || { revenueCents: 0, orderCount: 0 };
        const inStore = dailyInStoreMap[date] || { revenueCents: 0, orderCount: 0 };
        const online = dailyOnlineMap[date] || { revenueCents: 0, orderCount: 0 };
        return {
          date,
          revenueCents: d.revenueCents,
          orderCount: d.orderCount,
          inStoreRevenueCents: inStore.revenueCents,
          inStoreOrderCount: inStore.orderCount,
          onlineRevenueCents: online.revenueCents,
          onlineOrderCount: online.orderCount,
          inAppRevenueCents: inApp.revenueCents,
          inAppOrderCount: inApp.orderCount,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const orderCount = allPayments.length;
    const avgOrderValueCents = orderCount > 0 ? Math.round(totalRevenueCents / orderCount) : 0;

    return json({
      success: true,
      orderCount,
      totalRevenueCents,
      totalRevenue: (totalRevenueCents / 100).toFixed(2),
      totalDiscountCents,
      totalDiscount: (totalDiscountCents / 100).toFixed(2),
      totalProcessingFeeCents,
      totalProcessingFee: (totalProcessingFeeCents / 100).toFixed(2),
      avgOrderValueCents,
      avgOrderValue: (avgOrderValueCents / 100).toFixed(2),
      topItems,
      squareOrderCount: squareOrders.length,
      appOrderCount: (appOrders || []).length,
      dailyBreakdown,
    });
  } catch (e) {
    console.error("get-sales-report error:", e);
    return json({ success: false, error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
