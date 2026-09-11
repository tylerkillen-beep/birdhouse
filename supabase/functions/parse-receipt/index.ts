import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return json({ error: "No file provided" }, 400);

    // The shop's inventory and past confirmed matches, so each line can be
    // matched while the receipt is read. Both optional: an older admin page
    // that sends neither still gets a plain extraction.
    const inventory = parseList<InventoryRef>(form.get("inventory"));
    const known = parseList<KnownMatch>(form.get("known"));

    const buf = await file.arrayBuffer();
    const b64 = btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ''));

    // Items are offered by number, not uuid: a short number is easy to pick
    // and impossible to half-copy, and the response maps it back below.
    const refById = new Map(inventory.map((inv, i) => [inv.id, i + 1]));
    const inventoryList = inventory.length
      ? inventory.map((inv, i) => `${i + 1}. ${inv.name} (counted in ${inv.unit || "units"})`).join("\n")
      : "(no inventory list was sent -- use null for every inventory_ref)";
    const knownList = known
      .filter((k) => refById.has(k.inventory_id))
      .slice(0, 300)
      .map((k) => `- "${k.raw_name}" -> #${refById.get(k.inventory_id)}` +
        (k.counted_per_purchase ? `, counts as ${k.counted_per_purchase}` : ""))
      .join("\n");

    const prompt = `Extract every ordered item from this receipt.

For pack sizing, read the product title carefully: "Sprite Zero Sugar, 12 fl oz, 12 Pack"
means pack_count 12, unit_size 12, unit_size_uom "fl oz". "Hershey's Syrup 64 oz"
means pack_count 1, unit_size 64, unit_size_uom "oz". If the title gives a total
size but no piece count, set pack_count 1 and put the total in unit_size. Never
guess a size that is not printed on the receipt -- use null.

Keep names concise: brand plus key words, not the full listing title.

Then match each line to the shop's inventory list below, by number, in inventory_ref.
Match only when the line is clearly that item -- a different flavor, or a different
size of cup, is a different item. When unsure, use null: a wrong match adds stock
to the wrong shelf, while null just asks a person to pick. Lines that aren't shop
supplies (tax, fees, classroom or personal items) are null.

counted_per_purchase is how many of the matched item's counted units one purchased
unit adds. "Torani Vanilla Syrup 750 ml, 4 pack" matched to an item counted in
bottles is 4. Use null when the receipt doesn't make it clear, or when
inventory_ref is null.

match_note is a few words for the person reviewing: "Same wording as a past
receipt", "Not a shop supply", "No inventory item for this flavor".

Matches people have confirmed on past receipts (receipt wording -> item number):
${knownList || "(none yet)"}

Inventory:
${inventoryList}`;

    // A json_schema output format makes the response structurally valid by
    // construction. The previous free-text prompt relied on the model not
    // wrapping its JSON in prose or markdown, and a 15-page Amazon receipt
    // broke that with a mid-object truncation, which surfaced to staff as a raw
    // "Expected property name ... at position 1866" syntax error.
    const nullableNumber = { type: ["number", "null"] };
    const schema = {
      type: "object",
      properties: {
        vendor: { type: "string", enum: ["amazon", "walmart", "other"] },
        order_number: { type: ["string", "null"] },
        order_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
        expected_arrival: { type: ["string", "null"], description: "YYYY-MM-DD" },
        total_cents: { type: ["integer", "null"], description: "dollars x 100" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              quantity: { type: "number" },
              unit_cost_cents: { type: ["integer", "null"] },
              pack_count: nullableNumber,
              unit_size: nullableNumber,
              unit_size_uom: { type: ["string", "null"] },
              inventory_ref: { type: ["integer", "null"], description: "Number of the matching inventory item, or null" },
              counted_per_purchase: nullableNumber,
              match_note: { type: "string" },
            },
            required: [
              "name", "quantity", "unit_cost_cents", "pack_count", "unit_size", "unit_size_uom",
              "inventory_ref", "counted_per_purchase", "match_note",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["vendor", "order_number", "order_date", "expected_arrival", "total_cents", "items"],
      additionalProperties: false,
    };

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        // If a safety classifier ever declines a receipt, re-run it on
        // Anthropic's recommended fallback model instead of failing the upload.
        fallbacks: "default",
        // Each item now carries pack sizing too, so a long grocery receipt can
        // run well past the old 1024 cap -- and a truncated response fails the
        // JSON.parse below rather than degrading gracefully.
        max_tokens: 16000,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const claudeData = await claudeRes.json();

    // A refusal on the final response means the fallback declined too.
    if (claudeData.stop_reason === "refusal") {
      throw new Error("The receipt reader declined this file. Check it's the right PDF, or enter the order by hand.");
    }

    // Say plainly that the receipt was too long, rather than letting it surface
    // as an inscrutable JSON syntax error from a half-written object.
    if (claudeData.stop_reason === "max_tokens") {
      throw new Error(
        "This receipt has more items than one pass can extract. Split the PDF into " +
        "smaller parts and upload them as separate orders.",
      );
    }

    // Not content[0]: Claude Opus 5 thinks by default, so the first block can be
    // a thinking block. Take the text block wherever it lands.
    const text = (claudeData.content ?? []).find((b: { type: string }) => b.type === "text")?.text ?? "";
    if (!text.trim()) throw new Error("Claude returned no text to parse.");

    // json_schema output should never be fenced, but stripping is harmless.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("parse-receipt: unparseable response", { text: cleaned.slice(0, 2000) });
      throw new Error(`Could not read the parsed receipt: ${(parseErr as Error).message}`);
    }

    // Back from list numbers to inventory ids. A number outside the list is
    // treated as no match rather than trusted.
    for (const item of parsed.items ?? []) {
      const ref = item.inventory_ref;
      item.inventory_id = Number.isInteger(ref) && ref >= 1 && ref <= inventory.length
        ? inventory[ref - 1].id
        : null;
      delete item.inventory_ref;
    }
    // Tells the page the matches came from here, so it doesn't second-guess
    // a deliberate null with its own word-overlap guess.
    parsed.matched = inventory.length > 0;

    return json(parsed);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

interface InventoryRef {
  id: string;
  name: string;
  unit?: string | null;
}

interface KnownMatch {
  raw_name: string;
  inventory_id: string;
  counted_per_purchase?: number | null;
}

// A JSON array sent as a form field, or [] if it's missing or unreadable.
function parseList<T>(value: FormDataEntryValue | null): T[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
