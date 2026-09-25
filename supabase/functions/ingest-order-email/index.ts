// Supabase Edge Function: ingest-order-email
// Reads an Amazon or Walmart order email forwarded into a Gmail inbox and turns
// it into a purchase order, so receipts don't have to be uploaded by hand.
//
// A Google Apps Script in that inbox posts each new email here (see
// docs/email-intake.md). For each one this:
//
//   1. drops it if that exact email was seen before,
//   2. has Claude read it -- what kind of email it is, the order number(s), the
//      date, the expected arrival, the total, and each item matched to the
//      shop's inventory (the same reader as receipt uploads),
//   3. then, depending on what it is:
//        order placed / approved -> attach to the order you placed from Needs
//          Ordering, or update an order already recorded under that number, or
//          create a new pending order;
//        shipped / delivered -> update the arrival date or note on the order;
//        cancelled -> remove the order if nothing has arrived;
//        anything else (newsletters, receipts for other things) -> ignored.
//
// It never changes inventory counts. Those only move when a manager confirms a
// delivery arriving, so a wrong guess here costs a click, not a wrong count.
// Orders it isn't sure about are flagged needs_review for a person to check.
//
// Every email is logged in order_emails with what was done.
//
// Required Supabase secrets:
//   ANTHROPIC_API_KEY  (already set, used by parse-receipt)
//   INTAKE_SECRET      -- a long random string; the Apps Script sends it in the
//                         x-intake-secret header. The function refuses to run
//                         without it. Deploy with JWT verification OFF (the
//                         script carries no Supabase login).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-intake-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_TEXT_CHARS = 60_000;
const PLACED_ORDER_WINDOW_DAYS = 14;
// An email whose items add up to less than this share of its total is missing
// items (tax and shipping never come to more than a sliver of an order).
const COMPLETE_SHARE = 0.85;

type Vendor = "amazon" | "walmart" | "other";
type Kind = "order_placed" | "order_approved" | "shipped" | "delivered" | "cancelled" | "other";

interface InventoryRef { id: string; name: string; unit: string | null }
interface Alias { raw_name_norm: string; inventory_id: string; counted_per_purchase: number | null }

interface ParsedItem {
  name: string;
  quantity: number;
  unit_cost_cents: number | null;
  inventory_id: string | null;
  counted_per_purchase: number | null;
  match_note: string;
}

interface ParsedEmail {
  kind: Kind;
  vendor: Vendor;
  order_numbers: string[];
  order_date: string | null;
  expected_arrival: string | null;
  total_cents: number | null;
  items_stated: number | null;
  items: ParsedItem[];
}

class TransientError extends Error {}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("INTAKE_SECRET");
  if (!secret) return json({ error: "INTAKE_SECRET is not set" }, 500);
  if (!safeEqual(req.headers.get("x-intake-secret") ?? "", secret)) return json({ error: "Not authorized" }, 401);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  let body: { message_id?: string; subject?: string; from?: string; date?: string; text?: string; html?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send JSON" }, 400);
  }

  const messageId = String(body.message_id ?? "").trim();
  if (!messageId) return json({ error: "message_id is required" }, 400);

  const { data: seen } = await supabase.from("order_emails").select("id").eq("message_id", messageId).maybeSingle();
  if (seen) return json({ status: "duplicate", note: "This email was already read." });

  const text = emailText(body.text, body.html).slice(0, MAX_TEXT_CHARS);
  const log = {
    message_id: messageId,
    received_at: validDate(body.date),
    from_address: String(body.from ?? "").slice(0, 300) || null,
    subject: String(body.subject ?? "").slice(0, 500) || null,
  };

  if (text.length < 40) {
    return json(await record(supabase, log, { status: "ignored", note: "The email had no readable text." }));
  }

  try {
    const [{ data: inv }, { data: aliasRows }] = await Promise.all([
      supabase.from("inventory").select("id, name, unit").order("name"),
      supabase.from("inventory_aliases").select("raw_name_norm, inventory_id, counted_per_purchase"),
    ]);
    const inventory = (inv ?? []) as InventoryRef[];
    const aliases = new Map(((aliasRows ?? []) as Alias[]).map((a) => [a.raw_name_norm, a]));

    const parsed = await readEmail(text, log.subject, inventory, aliases);
    const result = await apply(supabase, parsed, aliases);
    return json(await record(supabase, log, { ...result, kind: parsed.kind, vendor: parsed.vendor, order_numbers: parsed.order_numbers, parsed }));
  } catch (err) {
    if (err instanceof TransientError) {
      // Nothing is logged, so the script tries this email again on its next run.
      console.error("ingest-order-email: transient failure", err.message);
      return json({ error: err.message }, 503);
    }
    console.error("ingest-order-email: failed", err);
    return json(await record(supabase, log, { status: "error", note: (err as Error).message.slice(0, 500) }));
  }
});

// ── Reading the email ────────────────────────────────────────────────────────
async function readEmail(
  text: string,
  subject: string | null,
  inventory: InventoryRef[],
  aliases: Map<string, Alias>,
): Promise<ParsedEmail> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  // Items are offered by number, not uuid, exactly as parse-receipt does.
  const refById = new Map(inventory.map((inv, i) => [inv.id, i + 1]));
  const inventoryList = inventory.length
    ? inventory.map((inv, i) => `${i + 1}. ${inv.name} (counted in ${inv.unit || "units"})`).join("\n")
    : "(no inventory list -- use null for every inventory_ref)";
  const knownList = [...aliases.values()]
    .filter((a) => refById.has(a.inventory_id))
    .slice(0, 300)
    .map((a) => `- "${a.raw_name_norm}" -> #${refById.get(a.inventory_id)}` +
      (a.counted_per_purchase ? `, counts as ${a.counted_per_purchase}` : ""))
    .join("\n");

  const prompt = `This is an email forwarded from a school coffee shop's inbox. It is probably an Amazon
(including Amazon Business) or Walmart email about a supply order, but it may be
something unrelated.

First say what kind of email it is:
- order_placed: an order confirmation ("Thanks for your order", "Order placed")
- order_approved: a business-office approval of a purchase request
- shipped: a shipping notice or delivery estimate for an existing order
- delivered: a delivery notice
- cancelled: an order or item was cancelled
- other: anything else (marketing, account notices, returns, receipts for something unrelated)

For the kinds that have items (order_placed, order_approved, and shipped or delivered
when they list items), extract every ordered item. An email can cover several order
numbers; list them all in order_numbers. Dates are YYYY-MM-DD. If the email gives a
delivery window, use its last day as expected_arrival. total_cents is the order total
in cents. items_stated is the number of items the email SAYS the order has (for
example "Items in order 7"), or null. Never invent items the email doesn't list, and
never guess a price, date or number that isn't printed -- use null.

For pack sizing, read the product title: "Sprite Zero Sugar, 12 fl oz, 12 Pack" is a
12 pack. Keep names concise: brand plus key words, not the full listing title.

Then match each item to the shop's inventory list below, by number, in inventory_ref.
Match only when the line is clearly that item -- a different flavor, or a different
size of cup, is a different item. When unsure, use null: a wrong match adds stock to
the wrong shelf, while null just asks a person to pick. Things that aren't shop
supplies (tax, fees, classroom or personal items) are null.

counted_per_purchase is how many of the matched item's counted units one purchased
unit adds ("Torani Vanilla Syrup 750 ml, 4 pack" matched to an item counted in bottles
is 4; a 500-count case of cups counted in 50-cup sleeves is 10). Use null when the email
doesn't make it clear, or when inventory_ref is null.

match_note is a few words for the person reviewing: "Same wording as a past order",
"Not a shop supply", "No inventory item for this flavor".

Matches people have confirmed on past orders (wording -> item number):
${knownList || "(none yet)"}

Inventory:
${inventoryList}

Email subject: ${subject ?? "(none)"}

Email:
${text}`;

  const nullableNumber = { type: ["number", "null"] };
  const schema = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["order_placed", "order_approved", "shipped", "delivered", "cancelled", "other"] },
      vendor: { type: "string", enum: ["amazon", "walmart", "other"] },
      order_numbers: { type: "array", items: { type: "string" } },
      order_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
      expected_arrival: { type: ["string", "null"], description: "YYYY-MM-DD" },
      total_cents: { type: ["integer", "null"], description: "dollars x 100" },
      items_stated: { type: ["integer", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            quantity: { type: "number" },
            unit_cost_cents: { type: ["integer", "null"] },
            inventory_ref: { type: ["integer", "null"], description: "Number of the matching inventory item, or null" },
            counted_per_purchase: nullableNumber,
            match_note: { type: "string" },
          },
          required: ["name", "quantity", "unit_cost_cents", "inventory_ref", "counted_per_purchase", "match_note"],
          additionalProperties: false,
        },
      },
    },
    required: ["kind", "vendor", "order_numbers", "order_date", "expected_arrival", "total_cents", "items_stated", "items"],
    additionalProperties: false,
  };

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        fallbacks: "default",
        max_tokens: 16000,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      }),
    });
  } catch (err) {
    throw new TransientError(`Could not reach the email reader: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const detail = await res.text();
    // Rate limits and outages are worth retrying; a bad request is not.
    if (res.status === 429 || res.status >= 500) throw new TransientError(`The email reader is busy (${res.status})`);
    throw new Error(`Claude API error: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("The email reader declined this email.");
  if (data.stop_reason === "max_tokens") throw new Error("This email has more items than one pass can read.");

  // Not content[0]: the first block can be a thinking block.
  const out = (data.content ?? []).find((b: { type: string }) => b.type === "text")?.text ?? "";
  if (!out.trim()) throw new Error("The email reader returned nothing.");
  const parsed = JSON.parse(out.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());

  // Back from list numbers to inventory ids; a number outside the list is no match.
  const items: ParsedItem[] = (parsed.items ?? []).map((it: Record<string, unknown>) => {
    const ref = it.inventory_ref as number | null;
    const id = Number.isInteger(ref) && (ref as number) >= 1 && (ref as number) <= inventory.length
      ? inventory[(ref as number) - 1].id
      : null;
    return {
      name: String(it.name ?? "Item"),
      quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      unit_cost_cents: (it.unit_cost_cents as number | null) ?? null,
      inventory_id: id,
      counted_per_purchase: Number(it.counted_per_purchase) > 0 ? Number(it.counted_per_purchase) : null,
      match_note: String(it.match_note ?? ""),
    };
  });

  // A match a person confirmed on a past order beats the reader's own guess.
  for (const it of items) {
    const known = aliases.get(normalizeName(it.name));
    if (known) {
      it.inventory_id = known.inventory_id;
      if (known.counted_per_purchase) it.counted_per_purchase = known.counted_per_purchase;
      it.match_note = "Same wording as a past order";
    }
  }

  return {
    kind: parsed.kind,
    vendor: parsed.vendor,
    order_numbers: (parsed.order_numbers ?? []).map((n: string) => String(n).trim()).filter(Boolean),
    order_date: validDay(parsed.order_date),
    expected_arrival: validDay(parsed.expected_arrival),
    total_cents: parsed.total_cents ?? null,
    items_stated: parsed.items_stated ?? null,
    items,
  };
}

// ── Doing something with it ──────────────────────────────────────────────────
interface Outcome {
  status: "created" | "matched" | "updated" | "duplicate" | "ignored" | "error";
  note: string;
  purchase_order_id?: string | null;
}

async function apply(supabase: SupabaseClient, e: ParsedEmail, _aliases: Map<string, Alias>): Promise<Outcome> {
  if (e.kind === "other") return { status: "ignored", note: "Not an order email." };
  if (!e.order_numbers.length && e.kind !== "order_placed" && e.kind !== "order_approved") {
    return { status: "ignored", note: "No order number to match it to." };
  }

  // An order already recorded under one of these numbers.
  const existing = await findByOrderNumber(supabase, e.vendor, e.order_numbers);

  if (e.kind === "cancelled") {
    if (!existing) return { status: "ignored", note: "Cancelled, but no order under that number." };
    const untouched = existing.status === "pending" && !existing.items.some((i) => Number(i.received_quantity) > 0);
    if (!untouched) {
      await supabase.from("purchase_orders").update({ needs_review: true, review_note: "The email says this order was cancelled, but part of it has arrived." }).eq("id", existing.id);
      return { status: "updated", note: "Flagged for review: cancelled after arriving.", purchase_order_id: existing.id };
    }
    await supabase.from("purchase_orders").delete().eq("id", existing.id);
    return { status: "updated", note: "Removed the order; the email says it was cancelled.", purchase_order_id: null };
  }

  if (e.kind === "shipped" || e.kind === "delivered") {
    if (!existing) return { status: "ignored", note: `A ${e.kind} notice for an order not recorded here.` };
    const patch: Record<string, unknown> = {};
    if (e.kind === "shipped" && e.expected_arrival) patch.expected_arrival = e.expected_arrival;
    if (e.kind === "delivered") {
      const stamp = `${e.vendor === "amazon" ? "Amazon" : e.vendor === "walmart" ? "Walmart" : "The vendor"} says it was delivered${e.expected_arrival ? " " + e.expected_arrival : ""}.`;
      patch.notes = [existing.notes, stamp].filter(Boolean).join(" ");
    }
    if (Object.keys(patch).length) await supabase.from("purchase_orders").update(patch).eq("id", existing.id);
    return { status: "updated", note: e.kind === "shipped" ? "Updated the expected arrival." : "Noted that it was delivered.", purchase_order_id: existing.id };
  }

  // order_placed / order_approved
  if (existing) {
    return { status: "duplicate", note: "An order with this number is already recorded.", purchase_order_id: existing.id };
  }
  if (!e.items.length) return { status: "ignored", note: "An order email with no items listed." };

  const orderNumber = e.order_numbers.join(", ") || null;
  const complete = isComplete(e);
  const matchedIds = new Set(e.items.map((i) => i.inventory_id).filter(Boolean) as string[]);

  // The order you placed from Needs Ordering, if this email is that order.
  const placed = await findPlacedOrder(supabase, e.vendor, matchedIds);
  if (placed) {
    await supabase.from("purchase_orders").update({
      order_number: orderNumber,
      order_date: e.order_date ?? placed.order_date,
      expected_arrival: e.expected_arrival ?? placed.expected_arrival,
      total_cents: e.total_cents ?? null,
      notes: [placed.notes, "Confirmed from the order email."].filter(Boolean).join(" "),
    }).eq("id", placed.id);
    return { status: "matched", note: `Attached to the order you placed${placed.order_date ? " on " + placed.order_date : ""}.`, purchase_order_id: placed.id };
  }

  // A new order.
  const reasons: string[] = [];
  const unmatched = e.items.filter((i) => !i.inventory_id && !/not a shop suppl|tax|fee/i.test(i.match_note));
  if (unmatched.length) reasons.push(`${unmatched.length} line${unmatched.length === 1 ? "" : "s"} not matched to inventory`);
  const noPack = e.items.filter((i) => i.inventory_id && !(Number(i.counted_per_purchase) > 0));
  if (noPack.length) reasons.push(`${noPack.length} matched line${noPack.length === 1 ? "" : "s"} without a pack size`);
  if (!complete) reasons.push(`the email lists ${e.items.length}${e.items_stated ? " of " + e.items_stated : ""} items, so some may be missing`);

  const { data: po, error: poErr } = await supabase.from("purchase_orders").insert({
    vendor: e.vendor,
    order_number: orderNumber,
    order_date: e.order_date,
    expected_arrival: e.expected_arrival,
    total_cents: e.total_cents,
    status: "pending",
    source: "email",
    needs_review: reasons.length > 0,
    review_note: reasons.length ? reasons.join("; ") : null,
    notes: e.kind === "order_approved" ? "From a business-office approval email." : null,
  }).select("id").single();
  if (poErr || !po) throw new Error(`Could not save the order: ${poErr?.message ?? "unknown error"}`);

  const { error: itemErr } = await supabase.from("purchase_order_items").insert(e.items.map((i) => ({
    purchase_order_id: po.id,
    raw_name: i.name,
    quantity: i.quantity,
    unit_cost_cents: i.unit_cost_cents,
    inventory_id: i.inventory_id,
    counted_per_purchase: i.counted_per_purchase,
  })));
  if (itemErr) {
    await supabase.from("purchase_orders").delete().eq("id", po.id);
    throw new Error(`Could not save the order's items: ${itemErr.message}`);
  }

  // Let Needs Ordering know those items are on their way.
  if (e.expected_arrival) {
    for (const id of matchedIds) {
      await supabase.from("inventory").update({ last_ordered_at: e.order_date ?? undefined, expected_arrival: e.expected_arrival }).eq("id", id);
    }
  }

  return {
    status: "created",
    note: reasons.length ? `New order; needs a look: ${reasons.join("; ")}.` : "New order recorded.",
    purchase_order_id: po.id,
  };
}

interface FoundOrder {
  id: string;
  status: string;
  notes: string | null;
  order_date: string | null;
  expected_arrival: string | null;
  items: { inventory_id: string | null; received_quantity: number | null }[];
}

async function findByOrderNumber(supabase: SupabaseClient, vendor: Vendor, numbers: string[]): Promise<FoundOrder | null> {
  if (!numbers.length) return null;
  const { data } = await supabase.from("purchase_orders")
    .select("id, status, notes, order_date, expected_arrival, order_number, purchase_order_items(inventory_id, received_quantity)")
    .eq("vendor", vendor)
    .not("order_number", "is", null)
    .order("created_at", { ascending: false })
    .limit(300);
  for (const po of data ?? []) {
    const have = String(po.order_number).split(/[,\s]+/).map((n) => n.trim()).filter(Boolean);
    if (numbers.some((n) => have.includes(n))) {
      return { id: po.id, status: po.status, notes: po.notes, order_date: po.order_date, expected_arrival: po.expected_arrival, items: po.purchase_order_items ?? [] };
    }
  }
  return null;
}

// The single open order placed from Needs Ordering that this email is most
// likely confirming: same vendor, no order number yet, recent, and sharing its
// items. If more than one fits, none is chosen -- a new order is safer than
// attaching to the wrong one.
async function findPlacedOrder(supabase: SupabaseClient, vendor: Vendor, emailIds: Set<string>): Promise<FoundOrder | null> {
  if (!emailIds.size) return null;
  const since = new Date(Date.now() - PLACED_ORDER_WINDOW_DAYS * 86_400_000).toISOString();
  const { data } = await supabase.from("purchase_orders")
    .select("id, status, notes, order_date, expected_arrival, purchase_order_items(inventory_id, received_quantity)")
    .eq("vendor", vendor)
    .eq("source", "needs_ordering")
    .eq("status", "pending")
    .is("order_number", null)
    .gte("created_at", since);
  const fits = (data ?? []).filter((po) => {
    const items = po.purchase_order_items ?? [];
    if (items.some((i: { received_quantity: number | null }) => Number(i.received_quantity) > 0)) return false;
    const ids = new Set(items.map((i: { inventory_id: string | null }) => i.inventory_id).filter(Boolean) as string[]);
    return overlap(emailIds, ids);
  });
  if (fits.length !== 1) return null;
  const po = fits[0];
  return { id: po.id, status: po.status, notes: po.notes, order_date: po.order_date, expected_arrival: po.expected_arrival, items: po.purchase_order_items ?? [] };
}

// ── Small pure helpers ───────────────────────────────────────────────────────
// Do the two sets of items describe the same order? Judged against the smaller
// set, because Amazon Business emails can list only some of an order's items.
function overlap(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared++;
  return shared >= 1 && shared / Math.min(a.size, b.size) >= 0.6;
}

// Does the email list the whole order? False when it says it has more items than
// it lists, or when the listed items come to well under the total.
function isComplete(e: Pick<ParsedEmail, "items" | "items_stated" | "total_cents">): boolean {
  if (e.items_stated && e.items.length < e.items_stated) return false;
  if (e.total_cents && e.total_cents > 0) {
    const priced = e.items.every((i) => i.unit_cost_cents != null);
    if (priced && e.items.length) {
      const sum = e.items.reduce((s, i) => s + (i.unit_cost_cents as number) * i.quantity, 0);
      if (sum < e.total_cents * COMPLETE_SHARE) return false;
    }
  }
  return true;
}

// The same loose normalization the receipt review screen uses, so wording matches
// the remembered aliases.
function normalizeName(name: string): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function emailText(text?: string, html?: string): string {
  const plain = String(text ?? "").trim();
  if (plain.length >= 200 || !html) return plain;
  const stripped = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return stripped.length > plain.length ? stripped : plain;
}

function validDay(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function validDate(v: unknown): string | null {
  const d = new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function record(
  supabase: SupabaseClient,
  log: { message_id: string; received_at: string | null; from_address: string | null; subject: string | null },
  out: Partial<Outcome> & { status: Outcome["status"]; kind?: string; vendor?: string; order_numbers?: string[]; parsed?: unknown },
) {
  const { error } = await supabase.from("order_emails").insert({
    ...log,
    kind: out.kind ?? null,
    vendor: out.vendor ?? null,
    order_numbers: out.order_numbers ?? [],
    status: out.status,
    purchase_order_id: out.purchase_order_id ?? null,
    note: out.note ?? null,
    parsed: out.parsed ?? null,
  });
  if (error) console.error("ingest-order-email: could not log the email", error.message);
  return { status: out.status, note: out.note ?? null, purchase_order_id: out.purchase_order_id ?? null };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
