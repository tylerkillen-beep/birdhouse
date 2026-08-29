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

    const buf = await file.arrayBuffer();
    const b64 = btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ''));

    const prompt = `Extract all ordered items from this receipt. Return ONLY a JSON object — no explanation, no markdown — with this exact structure:
{
  "vendor": "amazon" or "walmart" or "other",
  "order_number": "string or null",
  "order_date": "YYYY-MM-DD or null",
  "expected_arrival": "YYYY-MM-DD or null",
  "total_cents": integer (dollars × 100),
  "items": [
    {
      "name": "concise product name (omit long descriptions, keep brand + key words)",
      "quantity": number of units/cases ordered,
      "unit_cost_cents": price per unit in cents,
      "pack_count": how many individual pieces are in ONE purchased unit (a 12-pack of cans = 12, a single 64 fl oz bottle = 1), or null if not stated,
      "unit_size": the size of ONE individual piece as a number (a 12 fl oz can = 12, a 64 fl oz bottle = 64), or null if not stated,
      "unit_size_uom": the unit for unit_size, lowercase, one of "fl oz", "oz", "lb", "g", "ml", "l", "ct", or null if not stated
    }
  ]
}

For pack sizing, read the product title carefully: "Sprite Zero Sugar, 12 fl oz, 12 Pack"
means pack_count 12, unit_size 12, unit_size_uom "fl oz". "Hershey's Syrup 64 oz"
means pack_count 1, unit_size 64, unit_size_uom "oz". If the title gives a total
size but no piece count, set pack_count 1 and put the total in unit_size. Never
guess a size that is not printed on the receipt -- use null.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        // Each item now carries pack sizing too, so a long grocery receipt can
        // run well past the old 1024 cap -- and a truncated response fails the
        // JSON.parse below rather than degrading gracefully.
        max_tokens: 16000,
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
    const text = claudeData.content?.[0]?.text ?? "";

    // Strip possible markdown code fences before parsing
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    return json(parsed);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
