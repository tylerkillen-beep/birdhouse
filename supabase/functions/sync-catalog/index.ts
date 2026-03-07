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
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
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

    const squareLocationId = Deno.env.get("SQUARE_LOCATION_ID");
    if (!squareLocationId) return json({ success: false, error: "Missing SQUARE_LOCATION_ID secret" }, 500);

    const squareBaseUrl = getSquareBaseUrl();
    const squareHeaders = {
      "Authorization": `Bearer ${squareToken}`,
      "Square-Version": "2024-01-18",
      "Content-Type": "application/json",
    };

    // Fetch all catalog objects (ITEM_VARIATION and CATEGORY) for price/category lookups
    const allObjects: SquareObject[] = [];
    let listCursor: string | undefined;

    do {
      const params = new URLSearchParams({ types: "ITEM_VARIATION,CATEGORY" });
      if (listCursor) params.set("cursor", listCursor);

      const sqRes = await fetch(`${squareBaseUrl}/v2/catalog/list?${params.toString()}`, {
        headers: squareHeaders,
      });
      const sqBody = await sqRes.json();
      if (!sqRes.ok || sqBody?.errors?.length) {
        return json({ success: false, error: sqBody?.errors?.[0]?.detail || "Square API error" }, 400);
      }
      allObjects.push(...(sqBody.objects || []));
      listCursor = sqBody.cursor || undefined;
    } while (listCursor);

    const categories = new Map<string, string>();
    const variations = new Map<string, number>();

    for (const o of allObjects) {
      if (o.type === "CATEGORY") categories.set(o.id, o.category_data?.name || "Coffee");
      if (o.type === "ITEM_VARIATION") variations.set(o.id, o.item_variation_data?.price_money?.amount || 0);
    }

    // Use SearchCatalogItems with enabled_location_ids to only fetch items for this location
    const locationItems: SquareObject[] = [];
    let searchCursor: string | undefined;

    do {
      const searchBody: Record<string, unknown> = {
        enabled_location_ids: [squareLocationId],
      };
      if (searchCursor) searchBody.cursor = searchCursor;

      const sqRes = await fetch(`${squareBaseUrl}/v2/catalog/search-catalog-items`, {
        method: "POST",
        headers: squareHeaders,
        body: JSON.stringify(searchBody),
      });
      const sqBody = await sqRes.json();
      if (!sqRes.ok || sqBody?.errors?.length) {
        return json({ success: false, error: sqBody?.errors?.[0]?.detail || "Square search API error" }, 400);
      }
      locationItems.push(...(sqBody.items || []));
      searchCursor = sqBody.cursor || undefined;
    } while (searchCursor);

    const items = locationItems.filter((o) => o.item_data?.name);
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
        available: true,
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
          .insert({ ...payload, sort_order, square_modifier_list_ids: [] });
        if (!error) {
          inserted += 1;
        } else {
          insertErrors += 1;
          if (sampleErrors.length < 8) sampleErrors.push(`insert ${item.id}: ${error.message}`);
        }
      }
    }

    // Delete any menu items with a square_item_id not in the location's item set
    const validSquareIds = items.map((o) => o.id);
    let deleted = 0;
    let deleteErrors = 0;
    if (validSquareIds.length > 0) {
      const { data: toDelete } = await serviceClient
        .from("menu_items")
        .select("id, square_item_id")
        .not("square_item_id", "is", null)
        .not("square_item_id", "in", `(${validSquareIds.join(",")})`);

      for (const row of toDelete || []) {
        const { error } = await serviceClient.from("menu_items").delete().eq("id", row.id);
        if (!error) {
          deleted += 1;
        } else {
          deleteErrors += 1;
          if (sampleErrors.length < 8) sampleErrors.push(`delete ${row.square_item_id}: ${error.message}`);
        }
      }
    }

    const diagnostics = {
      scannedSquareObjects: locationItems.length,
      totalSquareItems: items.length,
      attemptedWrites: items.length,
      inserted,
      updated,
      deleted,
      skippedNoVariation,
      lookupErrors,
      insertErrors,
      updateErrors,
      deleteErrors,
      sampleErrors,
    };

    console.log("sync-catalog diagnostics", diagnostics);
    return json({ success: true, ...diagnostics });
  } catch (e) {
    console.error("sync-catalog error", e);
    return json({ success: false, error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
