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
  id?: string;
  type?: string;
  name: string;
  quantity: number;
  price: number;
  priceCents?: number;
  fullPriceCents?: number;
  selectedModifiers?: { priceCents?: number }[];
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

    // Discounts are kept apart by where they were given: rung up in Square
    // (POS / Square Online) or taken on the Birdhouse site (website sales,
    // staff and teacher pricing).
    type ItemTotals = { quantity: number; revenueCents: number; squareDiscountCents: number; siteDiscountCents: number };
    const itemMap: Record<string, ItemTotals> = {};
    const itemTotals = (name: string) =>
      itemMap[name] ??= { quantity: 0, revenueCents: 0, squareDiscountCents: 0, siteDiscountCents: 0 };

    for (const order of squareOrders) {
      // Skip shadow orders auto-created by Square for Birdhouse App payments.
      // These have no real line items and would appear as "Unknown Item".
      const matchedPaymentId = paymentIdBySquareOrderId[order.id];
      if (matchedPaymentId && birdhousePaymentIds.has(matchedPaymentId)) continue;

      for (const lineItem of order.line_items || []) {
        const totals = itemTotals(lineItem.name || "Unknown Item");
        totals.quantity += parseInt(lineItem.quantity || "1", 10);
        totals.revenueCents += lineItem.total_money?.amount ?? 0;
        totals.squareDiscountCents += lineItem.total_discount_money?.amount ?? 0;
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
    const appCartItems: CartItem[] = (appOrders || []).flatMap(
      (order: { cart_items: unknown }) => Array.isArray(order.cart_items) ? order.cart_items as CartItem[] : []
    );

    // Orders placed before cart lines recorded fullPriceCents are priced from
    // the menu as it stands now, so a price change since then skews those.
    const legacyMenuIds = [...new Set(appCartItems
      .filter((item) => item.fullPriceCents == null && !item.type && item.id)
      .map((item) => String(item.id)))];
    const menuBaseCentsById: Record<string, number> = {};
    if (legacyMenuIds.length) {
      const { data: menuRows } = await serviceClient
        .from("menu_items")
        .select("id, base_price, base_price_cents")
        .in("id", legacyMenuIds);
      for (const row of menuRows || []) {
        menuBaseCentsById[row.id] = row.base_price_cents || Math.round((parseFloat(row.base_price) || 0) * 100);
      }
    }

    for (const item of appCartItems) {
      const totals = itemTotals(item.name || "Unknown Item");
      const qty = Number(item.quantity) || 1;
      const unitCents = item.priceCents ?? Math.round((item.price || 0) * 100);
      const rev = unitCents * qty;
      totals.quantity += qty;
      totals.revenueCents += rev;

      let fullUnitCents = item.fullPriceCents;
      if (fullUnitCents == null && item.id && menuBaseCentsById[item.id] != null) {
        const modifierCents = (item.selectedModifiers || []).reduce((s, m) => s + (Number(m.priceCents) || 0), 0);
        fullUnitCents = menuBaseCentsById[item.id] + modifierCents;
      }
      if (fullUnitCents != null) {
        totals.siteDiscountCents += Math.max(0, fullUnitCents * qty - rev);
      }
    }

    // ── What one unit of each item costs to make ─────────────────────────────
    // A team's product uses the cost admin set on the team, the same number
    // Product Performance and the Canvas product score use. Anything else uses
    // its recipe's ingredient cost, but only when every ingredient is costed in
    // matching units -- a partial cost would overstate profit. Read here with
    // the service role because students can't read team costs themselves.
    const [{ data: teamRows }, { data: recipeCostRows }] = await Promise.all([
      serviceClient.from("teams").select("product_name, cost_cents").not("product_name", "is", null),
      serviceClient.from("recipe_costs").select("recipe_name, cost_cents, ingredient_count, ingredients_missing_cost, ingredients_unit_mismatch"),
    ]);
    const unitCostByName = new Map<string, { cents: number; source: "team" | "recipe" }>();
    for (const r of recipeCostRows || []) {
      if (!Number(r.ingredient_count) || Number(r.ingredients_missing_cost) || Number(r.ingredients_unit_mismatch)) continue;
      unitCostByName.set(String(r.recipe_name).trim().toLowerCase(), { cents: Number(r.cost_cents), source: "recipe" });
    }
    for (const t of teamRows || []) {
      if (t.cost_cents == null || !String(t.product_name).trim()) continue;
      unitCostByName.set(String(t.product_name).trim().toLowerCase(), { cents: Number(t.cost_cents), source: "team" });
    }

    // Prorate processing fees to each item by its share of total revenue
    const topItems = Object.entries(itemMap)
      .map(([name, d]) => {
        const processingFeeCents = totalRevenueCents > 0
          ? Math.round(totalProcessingFeeCents * d.revenueCents / totalRevenueCents)
          : 0;
        // Profit is revenue (already after discounts) minus fees and cost of
        // goods, as Product Performance works it out. Null when no cost is known.
        const unitCost = unitCostByName.get(name.trim().toLowerCase());
        const cogsCents = unitCost ? Math.round(unitCost.cents * d.quantity) : null;
        const profitCents = cogsCents == null ? null : d.revenueCents - processingFeeCents - cogsCents;
        return {
          name,
          quantity: d.quantity,
          revenueCents: d.revenueCents,
          discountCents: d.squareDiscountCents + d.siteDiscountCents,
          squareDiscountCents: d.squareDiscountCents,
          siteDiscountCents: d.siteDiscountCents,
          processingFeeCents,
          unitCostCents: unitCost ? unitCost.cents : null,
          costSource: unitCost ? unitCost.source : null,
          cogsCents,
          profitCents,
          marginPct: profitCents != null && d.revenueCents > 0 ? profitCents / d.revenueCents * 100 : null,
        };
      })
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 50);

    const totalSquareDiscountCents = Object.values(itemMap).reduce((s, d) => s + d.squareDiscountCents, 0);
    const totalSiteDiscountCents = Object.values(itemMap).reduce((s, d) => s + d.siteDiscountCents, 0);
    const totalDiscountCents = totalSquareDiscountCents + totalSiteDiscountCents;

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
      totalSquareDiscountCents,
      totalSiteDiscountCents,
      totalProcessingFeeCents,
      totalProcessingFee: (totalProcessingFeeCents / 100).toFixed(2),
      avgOrderValueCents,
      avgOrderValue: (avgOrderValueCents / 100).toFixed(2),
      topItems,
      squareOrderCount: squareOrders.length,
      appOrderCount: (appOrders || []).length,
      dailyBreakdown,
      // Every completed payment with its time, so a report can total sales
      // made within particular hours (the Library Split uses class periods).
      payments: allPayments.map((p) => ({
        createdAt: p.created_at,
        amountCents: p.amount_money?.amount ?? 0,
        feeCents: (p.processing_fee || []).reduce((s, f) => s + (f.amount_money?.amount ?? 0), 0),
      })),
    });
  } catch (e) {
    console.error("get-sales-report error:", e);
    return json({ success: false, error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
