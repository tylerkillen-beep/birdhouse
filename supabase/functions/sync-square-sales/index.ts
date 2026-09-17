// Supabase Edge Function: sync-square-sales
// Copies completed Square orders -- register and Square Online -- into
// square_sale_lines, one row per line item, for the Team Hub's Item Lookup.
//
// Read-only against Square: it searches orders and reads catalog and customer
// names, and never creates or changes anything there.
//
// Each run does two things, in this order:
//   1. New sales: everything closed since the last run (with an overlap, so an
//      order that closed while a run was underway is not missed).
//   2. History: walks backward two weeks at a time from the first run until it
//      reaches the day the Square location opened, then stops for good.
// Rows are upserted by (order, line), so repeating any window is harmless and a
// run cut short just picks up where it left off next time.
//
// Birdhouse website orders and subscription charges also appear in Square, as
// bare payments with an empty order. Those carry no line items and are skipped
// by payment id besides, so nothing is counted twice -- the website's own
// orders table is the record for those sales.
//
// Required Supabase secrets:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENV (already set)
//   CRON_SECRET  -- the scheduler sends it as x-cron-secret
//
// Also accepts a signed-in Team Hub staff member (the "Sync now" button).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

const SQUARE_VERSION = "2024-01-18";
const OWNER_EMAIL = "tylerkillen@nixaschools.net";

const TIME_BUDGET_MS = 30_000;          // stop starting new work after this
const REQUEST_TIMEOUT_MS = 20_000;      // give up on any one call to Square or the database
const HISTORY_WINDOW_DAYS = 14;         // history is copied this many days per step
const NEW_SALES_OVERLAP_MS = 2 * 60 * 60 * 1000;
const CUSTOMER_LOOKUPS_PER_RUN = 150;   // names are fetched one at a time
const EARLIEST_FALLBACK = "2015-01-01T00:00:00Z";

type Money = { amount?: number };

interface SquareModifier {
  name?: string;
  catalog_object_id?: string;
  total_price_money?: Money;
}

interface SquareLineItem {
  uid?: string;
  name?: string;
  quantity?: string;
  catalog_object_id?: string;
  variation_name?: string;
  gross_sales_money?: Money;
  total_discount_money?: Money;
  total_money?: Money;
  modifiers?: SquareModifier[];
}

interface SquareOrder {
  id: string;
  created_at: string;
  closed_at?: string;
  customer_id?: string;
  source?: { name?: string };
  line_items?: SquareLineItem[];
  tenders?: { payment_id?: string; customer_id?: string }[];
}

// Every outside call gets a deadline. Without one, a call that never answers
// holds the run open until Supabase stops it at 150 seconds, with no reply to
// the caller and nothing in the logs.
function timedFetch(input: Request | URL | string, init?: RequestInit) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function isTimeout(err: unknown) {
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function squareBaseUrl() {
  const env = (Deno.env.get("SQUARE_ENV") || "production").toLowerCase();
  return env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

async function isAllowed(req: Request, supabase: SupabaseClient): Promise<boolean> {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) return true;

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return false;
  if ((user.email || "").toLowerCase() === OWNER_EMAIL) return true;
  const { data: staff } = await supabase.from("students").select("role").eq("id", user.id).maybeSingle();
  return ["student", "manager", "admin"].includes(staff?.role);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    global: { fetch: timedFetch },
    auth: { persistSession: false },
  });

  // Progress lines in the function's logs, so a slow or stuck run shows where.
  const log = (step: string, detail: Record<string, unknown> = {}) =>
    console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${step}`, JSON.stringify(detail));

  log("start");
  if (!(await isAllowed(req, supabase))) return json({ success: false, error: "Not authorized" }, 401);
  log("authorized");

  const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
  const locationId = Deno.env.get("SQUARE_LOCATION_ID");
  if (!squareToken || !locationId) return json({ success: false, error: "Square credentials not configured" }, 500);

  const base = squareBaseUrl();
  const headers = {
    "Authorization": `Bearer ${squareToken}`,
    "Square-Version": SQUARE_VERSION,
    "Content-Type": "application/json",
  };

  const square = async (path: string, init?: RequestInit) => {
    let res: Response;
    try {
      res = await timedFetch(`${base}${path}`, { ...init, headers });
    } catch (err) {
      throw new Error(isTimeout(err)
        ? `Square did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds (${path})`
        : `Could not reach Square (${path}): ${err instanceof Error ? err.message : err}`);
    }
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && !body?.errors?.length, status: res.status, body };
  };

  const stats = { newSalesLines: 0, historyLines: 0, historyWindows: 0, variationsLearned: 0, customersLearned: 0 };

  try {
    // ── Where the last run left off ───────────────────────────────────────
    const runStartIso = new Date(startedAt).toISOString();
    let { data: state, error: stateError } = await supabase.from("square_sales_sync").select("*").eq("id", true).maybeSingle();
    if (stateError) throw new Error(`Could not read sync progress: ${stateError.message}`);
    log("loaded progress", { state });

    if (!state) {
      // First run: new sales start now, history walks back from now.
      const { body } = await square(`/v2/locations/${locationId}`);
      const opened = body?.location?.created_at || EARLIEST_FALLBACK;
      state = {
        id: true,
        synced_through: runStartIso,
        backfill_before: runStartIso,
        backfill_floor: opened,
        backfill_done: false,
      };
      const { error } = await supabase.from("square_sales_sync").insert(state);
      if (error) throw new Error(`Could not start the sync: ${error.message}`);
      log("first run", { opened });
    }

    // ── Copy one window of completed orders ──────────────────────────────
    const copyWindow = async (startIso: string, endIso: string): Promise<number | null> => {
      let cursor: string | undefined;
      let copied = 0;
      do {
        if (outOfTime()) return null;
        const { ok, body } = await square("/v2/orders/search", {
          method: "POST",
          body: JSON.stringify({
            location_ids: [locationId],
            query: {
              filter: {
                state_filter: { states: ["COMPLETED"] },
                date_time_filter: { closed_at: { start_at: startIso, end_at: endIso } },
              },
              sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
            },
            limit: 500,
            ...(cursor ? { cursor } : {}),
          }),
        });
        if (!ok) {
          const e = body?.errors?.[0];
          throw new Error(`Square order search failed: ${e?.detail || e?.code || "unknown error"}`);
        }
        const saved = await saveOrders(body.orders || []);
        copied += saved;
        log("orders page", { from: startIso, to: endIso, orders: (body.orders || []).length, linesSaved: saved, more: !!body.cursor });
        cursor = body.cursor || undefined;
      } while (cursor);
      return copied;
    };

    const saveOrders = async (orders: SquareOrder[]): Promise<number> => {
      const withLines = orders.filter((o) => o.line_items?.length);
      if (!withLines.length) return 0;

      // Payments the website or subscription billing made -- their own tables
      // already record those sales.
      const paymentIds = [...new Set(withLines.flatMap((o) => (o.tenders || []).map((t) => t.payment_id).filter(Boolean)))] as string[];
      const sitePayments = new Set<string>();
      for (let i = 0; i < paymentIds.length; i += 100) {
        const chunk = paymentIds.slice(i, i + 100);
        const [{ data: web, error: webError }, { data: subs, error: subsError }] = await Promise.all([
          supabase.from("orders").select("square_payment_id").in("square_payment_id", chunk),
          supabase.from("subscription_charges").select("square_payment_id").in("square_payment_id", chunk),
        ]);
        // Guessing here could count a website sale twice, so stop instead.
        const lookupError = webError || subsError;
        if (lookupError) throw new Error(`Checking for website payments failed: ${lookupError.message}`);
        for (const r of [...(web || []), ...(subs || [])]) if (r.square_payment_id) sitePayments.add(r.square_payment_id);
      }

      const rows = [];
      for (const order of withLines) {
        if ((order.tenders || []).some((t) => t.payment_id && sitePayments.has(t.payment_id))) continue;
        const channel = (order.source?.name || "").toLowerCase().includes("online") ? "square_online" : "register";
        const customerId = order.customer_id || order.tenders?.find((t) => t.customer_id)?.customer_id || null;
        order.line_items!.forEach((li, idx) => {
          rows.push({
            square_order_id: order.id,
            line_uid: li.uid || `line-${idx}`,
            closed_at: order.closed_at || order.created_at,
            channel,
            catalog_object_id: li.catalog_object_id || null,
            item_name: li.name || "Custom amount",
            variation_name: li.variation_name || null,
            quantity: Number(li.quantity) || 1,
            gross_cents: li.gross_sales_money?.amount ?? 0,
            discount_cents: li.total_discount_money?.amount ?? 0,
            net_cents: li.total_money?.amount ?? 0,
            modifiers: (li.modifiers || []).map((m) => ({
              name: m.name || "",
              catalog_object_id: m.catalog_object_id || null,
              price_cents: m.total_price_money?.amount ?? 0,
            })),
            square_customer_id: customerId,
            synced_at: new Date().toISOString(),
          });
        });
      }

      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase
          .from("square_sale_lines")
          .upsert(rows.slice(i, i + 500), { onConflict: "square_order_id,line_uid" });
        if (error) throw new Error(`Saving register sales failed: ${error.message}`);
      }
      return rows.length;
    };

    // ── 1. New sales ──────────────────────────────────────────────────────
    const newFrom = new Date(new Date(state.synced_through).getTime() - NEW_SALES_OVERLAP_MS).toISOString();
    const newCopied = await copyWindow(newFrom, runStartIso);
    if (newCopied !== null) {
      stats.newSalesLines = newCopied;
      await supabase.from("square_sales_sync").update({ synced_through: runStartIso }).eq("id", true);
    }

    // ── 2. History ────────────────────────────────────────────────────────
    let before = new Date(state.backfill_before);
    const floor = new Date(state.backfill_floor || EARLIEST_FALLBACK);
    let done = state.backfill_done || before <= floor;
    while (!done && !outOfTime()) {
      const start = new Date(Math.max(floor.getTime(), before.getTime() - HISTORY_WINDOW_DAYS * 86_400_000));
      const copied = await copyWindow(start.toISOString(), before.toISOString());
      if (copied === null) break; // out of time mid-window; redo it next run
      stats.historyLines += copied;
      stats.historyWindows += 1;
      before = start;
      done = before <= floor;
      await supabase.from("square_sales_sync")
        .update({ backfill_before: before.toISOString(), backfill_done: done })
        .eq("id", true);
    }

    // ── Which item each variation belongs to ─────────────────────────────
    log("sales copied", { ...stats, backfillBefore: before.toISOString(), done });
    if (!outOfTime()) stats.variationsLearned = await learnVariations(supabase, square);

    // ── Names of customers attached at the register ──────────────────────
    if (!outOfTime()) stats.customersLearned = await learnCustomers(supabase, square, outOfTime);
    log("finished", stats);

    await supabase.from("square_sales_sync")
      .update({ last_run_at: new Date().toISOString(), last_error: null })
      .eq("id", true);

    const { data: finalState } = await supabase.from("square_sales_sync").select("*").eq("id", true).maybeSingle();
    return json({ success: true, ...stats, state: finalState });
  } catch (err) {
    const message = isTimeout(err)
      ? `A database call did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`
      : err instanceof Error ? err.message : "Unexpected error";
    console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] sync-square-sales error:`, message, err);
    await supabase.from("square_sales_sync")
      .update({ last_run_at: new Date().toISOString(), last_error: message })
      .eq("id", true);
    return json({ success: false, error: message, ...stats }, 500);
  }
});

type SquareCall = (path: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; body: any }>;

async function learnVariations(supabase: SupabaseClient, square: SquareCall): Promise<number> {
  const { data: missing, error } = await supabase.rpc("square_variations_to_learn", { p_limit: 1000 });
  if (error) throw new Error(`Looking up unknown items failed: ${error.message}`);
  const ids: string[] = (missing || []).map((r: { catalog_object_id: string }) => r.catalog_object_id);
  if (!ids.length) return 0;

  const { ok, body } = await square("/v2/catalog/batch-retrieve", {
    method: "POST",
    body: JSON.stringify({ object_ids: ids, include_related_objects: true, include_deleted_objects: true }),
  });
  if (!ok) throw new Error(`Square catalog lookup failed: ${body?.errors?.[0]?.detail || "unknown error"}`);

  const itemNames = new Map<string, string>();
  for (const obj of [...(body.objects || []), ...(body.related_objects || [])]) {
    if (obj.type === "ITEM") itemNames.set(obj.id, obj.item_data?.name || "");
  }

  const found = new Map<string, Record<string, unknown>>();
  for (const obj of body.objects || []) {
    if (obj.type !== "ITEM_VARIATION") continue;
    const itemId = obj.item_variation_data?.item_id || null;
    found.set(obj.id, {
      variation_id: obj.id,
      item_id: itemId,
      item_name: (itemId && itemNames.get(itemId)) || null,
      variation_name: obj.item_variation_data?.name || null,
      fetched_at: new Date().toISOString(),
    });
  }
  // Remember ids Square no longer has too, so they aren't asked about every run.
  const rows = ids.map((id) => found.get(id) || { variation_id: id, item_id: null, item_name: null, variation_name: null, fetched_at: new Date().toISOString() });
  const { error: saveError } = await supabase.from("square_catalog_variations").upsert(rows, { onConflict: "variation_id" });
  if (saveError) throw new Error(`Saving item lookups failed: ${saveError.message}`);
  return rows.length;
}

async function learnCustomers(supabase: SupabaseClient, square: SquareCall, outOfTime: () => boolean): Promise<number> {
  const { data: missing, error } = await supabase.rpc("square_customers_to_learn", { p_limit: CUSTOMER_LOOKUPS_PER_RUN });
  if (error) throw new Error(`Looking up unknown customers failed: ${error.message}`);
  let learned = 0;
  for (const { square_customer_id: id } of (missing || []) as { square_customer_id: string }[]) {
    if (outOfTime()) break;
    const { ok, status, body } = await square(`/v2/customers/${encodeURIComponent(id)}`);
    if (!ok && status !== 404) continue; // try again next run
    const c = body?.customer || {};
    const name = [c.given_name, c.family_name].filter(Boolean).join(" ").trim() || c.company_name || c.nickname || null;
    const { error: saveError } = await supabase
      .from("square_customer_names")
      .upsert({ square_customer_id: id, display_name: name, fetched_at: new Date().toISOString() }, { onConflict: "square_customer_id" });
    if (saveError) throw new Error(`Saving customer names failed: ${saveError.message}`);
    learned += 1;
  }
  return learned;
}
