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
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));

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
      "unit_cost_cents": price per unit in cents
    }
  ]
}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 1024,
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
