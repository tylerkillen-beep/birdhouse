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

type SquareObject = {
  id: string;
  type: string;
  item_data?: {
    name?: string;
    description?: string;
    category_id?: string;
    variations?: Array<{ id: string }>;
  };
  category_data?: {
    name?: string;
  };
  item_variation_data?: {
    price_money?: { amount?: number };
  };
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anon || !service) {
      return json({
        success: false,
        error: "Missing required Supabase environment variables",
      }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";

    const userClient = createClient(supabaseUrl, anon, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();

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
      allowed = !!student && ["admin", "manager"].includes(student.role);
    }

    if (!allowed) return json({ success: false, error: "Forbidden" }, 403);

    const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
    if (!squareToken) return json({ success: false, error: "Missing SQUARE_ACCESS_TOKEN secret" }, 500);

    const squareBaseUrl = getSquareBaseUrl();
    const squareHeaders = {
      "Authorization": `Bearer ${squareToken}`,
      "Square-Version": "2024-01-18",
      "Content-Type": "application/json",
    };

    // Use SQUARE_LOCATION_ID if set; otherwise, look up the "Birdhouse" location
    // by name via the Square Locations API so we only sync that location's items.
    let locationId = Deno.env.get("SQUARE_LOCATION_ID");
    if (!locationId) {
      const locRes = await fetch(`${squareBaseUrl}/v2/locations`, { headers: squareHeaders });
      if (locRes.ok) {
        const locBody = await locRes.json();
        const match = (locBody.locations ?? []).find(
          (l: { id: string; name?: string }) => l.name?.toLowerCase().includes("birdhouse"),
        );
        if (match) locationId = match.id;
      }
    }

    const objects: SquareObject[] = [];
    let cursor: string | undefined;

    // Use catalog/search to filter by location when a location ID is available,
    // otherwise fall back to catalog/list (pulls entire account catalog).
    do {
      let sqRes: Response;
      if (locationId) {
        const searchBody: Record<string, unknown> = {
          object_types: ["ITEM", "ITEM_VARIATION", "CATEGORY"],
          query: { location_query: { location_ids: [locationId] } },
        };
        if (cursor) searchBody.cursor = cursor;
        sqRes = await fetch(`${squareBaseUrl}/v2/catalog/search`, {
          method: "POST",
          headers: squareHeaders,
          body: JSON.stringify(searchBody),
        });
      } else {
        const params = new URLSearchParams({ types: "ITEM,ITEM_VARIATION,CATEGORY" });
        if (cursor) params.set("cursor", cursor);
        sqRes = await fetch(`${squareBaseUrl}/v2/catalog/list?${params.toString()}`, {
          headers: squareHeaders,
        });
      }

      const sqBody = await sqRes.json();
      if (!sqRes.ok || sqBody?.errors?.length) {
        return json({ success: false, error: sqBody?.errors?.[0]?.detail || "Square API error" }, 400);
      }

      objects.push(...(sqBody.objects || []));
      cursor = sqBody.cursor || undefined;
    } while (cursor);

    const categories = new Map<string, string>();
    const variations = new Map<string, number>();

    for (const o of objects) {
      if (o.type === "CATEGORY") categories.set(o.id, o.category_data?.name || "Coffee");
      if (o.type === "ITEM_VARIATION") variations.set(o.id, o.item_variation_data?.price_money?.amount || 0);
    }

    const items = objects.filter((o) => o.type === "ITEM" && o.item_data?.name);
    let inserted = 0;
    let updated = 0;
    let skippedNoVariation = 0;
    let lookupErrors = 0;
    let insertErrors = 0;
    let updateErrors = 0;
    const sampleErrors: string[] = [];

    for (const item of items) {
      const firstVarId = item.item_data?.variations?.[0]?.id;
      if (!firstVarId) skippedNoVariation += 1;
      const priceCents = firstVarId ? (variations.get(firstVarId) || 0) : 0;

      const payload = {
        name: item.item_data?.name || "Untitled",
        description: item.item_data?.description || "",
        category: categories.get(item.item_data?.category_id || "") || "Coffee",
        base_price_cents: priceCents,
        base_price: (priceCents / 100).toFixed(2),
        is_hot: true,
        is_iced: false,
        square_item_id: item.id,
      };

      const { data: existing, error: existingErr } = await serviceClient
        .from("menu_items")
        .select("id")
        .eq("square_item_id", item.id)
        .maybeSingle();

      if (existingErr) {
        lookupErrors += 1;
        if (sampleErrors.length < 8) sampleErrors.push(`lookup ${item.id}: ${existingErr.message}`);
        continue;
      }

      if (existing?.id) {
        const { error } = await serviceClient.from("menu_items").update(payload).eq("id", existing.id);
        if (!error) {
          updated += 1;
        } else {
          updateErrors += 1;
          if (sampleErrors.length < 8) sampleErrors.push(`update ${item.id}: ${error.message}`);
        }
      } else {
        const { data: maxSortRow } = await serviceClient
          .from("menu_items")
          .select("sort_order")
          .order("sort_order", { ascending: false })
          .limit(1)
          .maybeSingle();
        const sort_order = (maxSortRow?.sort_order || 0) + 1;
        const { error } = await serviceClient
          .from("menu_items")
          .insert({ ...payload, sort_order, square_modifier_list_ids: [], available: false });
        if (!error) {
          inserted += 1;
        } else {
          insertErrors += 1;
          if (sampleErrors.length < 8) sampleErrors.push(`insert ${item.id}: ${error.message}`);
        }
      }
    }

    const diagnostics = {
      locationId: locationId || "none (full catalog)",
      scannedSquareObjects: objects.length,
      totalSquareItems: items.length,
      attemptedWrites: items.length,
      inserted,
      updated,
      skippedNoVariation,
      lookupErrors,
      insertErrors,
      updateErrors,
      sampleErrors,
    };

    console.log("sync-catalog diagnostics", diagnostics);
    return json({ success: true, ...diagnostics });
  } catch (e) {
    console.error("sync-catalog error", e);
    return json({ success: false, error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
