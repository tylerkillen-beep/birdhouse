// Supabase Edge Function: get-sales-report
// Fetches sales data directly from Square Orders API for reporting.
// No data is stored locally — all results come live from Square.
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

interface SquareLineItem {
  name?: string;
  quantity?: string;
  gross_sales_money?: { amount: number; currency: string };
}

interface SquareOrder {
  id: string;
  created_at: string;
  state: string;
  total_money?: { amount: number; currency: string };
  line_items?: SquareLineItem[];
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

    // Allow owner email or any authenticated student
    const email = (user.email || "").toLowerCase();
    const serviceClient = createClient(supabaseUrl, service);

    let allowed = email === "tylerkillen@nixaschools.net";
    if (!allowed) {
      const { data: student } = await serviceClient
        .from("students")
        .select("role")
        .eq("id", user.id)
        .single();
      allowed = !!student; // any row in students table = staff member
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

    // ── Fetch orders from Square (paginated) ──────────────────────────────────
    const squareBaseUrl = getSquareBaseUrl();
    const squareHeaders = {
      "Authorization": `Bearer ${squareToken}`,
      "Square-Version": "2024-01-18",
      "Content-Type": "application/json",
    };

    const allOrders: SquareOrder[] = [];
    let cursor: string | undefined;

    do {
      const searchBody: Record<string, unknown> = {
        location_ids: [locationId],
        query: {
          filter: {
            date_time_filter: {
              created_at: { start_at: startDate, end_at: endDate },
            },
            state_filter: { states: ["COMPLETED"] },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
        },
        limit: 500,
      };
      if (cursor) searchBody.cursor = cursor;

      const sqRes = await fetch(`${squareBaseUrl}/v2/orders/search`, {
        method: "POST",
        headers: squareHeaders,
        body: JSON.stringify(searchBody),
      });

      const sqBody = await sqRes.json();
      if (!sqRes.ok || sqBody?.errors?.length) {
        return json({ success: false, error: sqBody?.errors?.[0]?.detail || "Square API error" }, 400);
      }

      allOrders.push(...(sqBody.orders || []));
      cursor = sqBody.cursor || undefined;
    } while (cursor);

    // ── Aggregate ─────────────────────────────────────────────────────────────
    let totalRevenueCents = 0;
    const itemMap: Record<string, { quantity: number; revenueCents: number }> = {};
    const dailyMap: Record<string, { revenueCents: number; orderCount: number }> = {};

    for (const order of allOrders) {
      const orderTotal = order.total_money?.amount ?? 0;
      totalRevenueCents += orderTotal;

      const day = order.created_at.slice(0, 10); // YYYY-MM-DD
      if (!dailyMap[day]) dailyMap[day] = { revenueCents: 0, orderCount: 0 };
      dailyMap[day].revenueCents += orderTotal;
      dailyMap[day].orderCount += 1;

      for (const item of order.line_items ?? []) {
        const name = item.name || "Unknown Item";
        const qty = parseInt(item.quantity ?? "1", 10);
        const rev = item.gross_sales_money?.amount ?? 0;
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

    const orderCount = allOrders.length;
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
