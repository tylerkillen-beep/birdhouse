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

// Use `any` for the raw Square objects so we don't accidentally drop fields
// that the type definition doesn't know about (e.g. location_overrides on
// item_variation_data, or menu_data on MENU objects).
// deno-lint-ignore no-explicit-any
type SquareRaw = Record<string, any>;

/** Return the best price in cents for a variation object.
 *  Checks (in order):
 *   1. item_variation_data.price_money.amount  (base price)
 *   2. item_variation_data.location_overrides[matching location].price_money.amount
 *   3. 0
 */
function extractPriceCents(varObj: SquareRaw | null | undefined, locationId: string | undefined): number {
  if (!varObj) return 0;
  const ivd = varObj.item_variation_data ?? varObj.itemVariationData;
  if (!ivd) return 0;

  const base = ivd.price_money?.amount ?? ivd.priceMoney?.amount;
  if (base != null && base > 0) return base;

  // Fall back to location-specific override
  if (locationId) {
    const overrides: SquareRaw[] = ivd.location_overrides ?? ivd.locationOverrides ?? [];
    for (const ov of overrides) {
      if (ov.location_id === locationId || ov.locationId === locationId) {
        const ovPrice = ov.price_money?.amount ?? ov.priceMoney?.amount;
        if (ovPrice != null && ovPrice > 0) return ovPrice;
      }
    }
  }

  return 0;
}

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

    const locationId = Deno.env.get("SQUARE_LOCATION_ID") || undefined;
    const menuName = (Deno.env.get("SQUARE_MENU_NAME") || "").trim();

    const squareBaseUrl = getSquareBaseUrl();
    const squareHeaders = {
      "Authorization": `Bearer ${squareToken}`,
      "Square-Version": "2024-01-18",
      "Content-Type": "application/json",
    };

    const objects: SquareRaw[] = [];
    let cursor: string | undefined;

    // Paginated fetch — include MENU so we can filter by menu name
    do {
      const params = new URLSearchParams({
        types: "ITEM,ITEM_VARIATION,CATEGORY,MENU",
      });
      if (cursor) params.set("cursor", cursor);

      const sqRes = await fetch(`${squareBaseUrl}/v2/catalog/list?${params.toString()}`, {
        headers: squareHeaders,
      });

      const sqBody = await sqRes.json();
      if (!sqRes.ok || sqBody?.errors?.length) {
        return json({ success: false, error: sqBody?.errors?.[0]?.detail || "Square API error" }, 400);
      }

      objects.push(...(sqBody.objects || []));
      cursor = sqBody.cursor || undefined;
    } while (cursor);

    // Build lookup maps
    const categories = new Map<string, string>();
    const variationObjects = new Map<string, SquareRaw>(); // variation id → full object

    for (const o of objects) {
      if (o.type === "CATEGORY") {
        categories.set(o.id, o.category_data?.name || "Coffee");
      }
      if (o.type === "ITEM_VARIATION") {
        variationObjects.set(o.id, o);
      }
    }

    // Build menu → item ID set map from MENU catalog objects
    const menuItemIds = new Map<string, Set<string>>(); // menu name (lower) → item ids
    for (const o of objects) {
      if (o.type !== "MENU") continue;
      const name: string = o.menu_data?.name ?? o.menuData?.name ?? "";
      if (!name) continue;
      const ids = new Set<string>();
      const sections: SquareRaw[] = o.menu_data?.sections ?? o.menuData?.sections ?? [];
      for (const sec of sections) {
        const entries: SquareRaw[] = sec.items ?? sec.catalog_items ?? [];
        for (const entry of entries) {
          const id = entry.item_id ?? entry.itemId ?? entry.catalog_item_id;
          if (id) ids.add(id);
        }
      }
      menuItemIds.set(name.toLowerCase(), ids);
    }

    // All catalog ITEM objects with a name
    let items: SquareRaw[] = objects.filter((o) => o.type === "ITEM" && o.item_data?.name);

    // Filter to a specific menu if SQUARE_MENU_NAME is set
    let menuFilterApplied = false;
    let menuFilteredItemCount = items.length;
    if (menuName) {
      const targetIds = menuItemIds.get(menuName.toLowerCase());
      if (targetIds && targetIds.size > 0) {
        items = items.filter((i) => targetIds.has(i.id));
        menuFilterApplied = true;
        menuFilteredItemCount = items.length;
      }
      // If no matching MENU object found, fall through and sync everything
    }

    // Sample raw variation for price diagnostics (returned in response)
    const sampleVariationRaw = objects.find((o) => o.type === "ITEM_VARIATION") ?? null;
    const sampleVariationPricePath = sampleVariationRaw
      ? {
          id: sampleVariationRaw.id,
          price_money: sampleVariationRaw.item_variation_data?.price_money,
          location_overrides: (sampleVariationRaw.item_variation_data?.location_overrides ?? []).slice(0, 2),
        }
      : null;

    let inserted = 0;
    let updated = 0;
    let skippedNoVariation = 0;
    let lookupErrors = 0;
    let insertErrors = 0;
    let updateErrors = 0;
    const sampleErrors: string[] = [];

    for (const item of items) {
      const embeddedVariations: SquareRaw[] = item.item_data?.variations ?? [];
      const firstEmbedded = embeddedVariations[0] ?? null;
      const firstVarId: string | undefined = firstEmbedded?.id;

      if (!firstVarId) {
        skippedNoVariation += 1;
      }

      // Prefer the top-level ITEM_VARIATION object (has location_overrides);
      // fall back to the embedded variation stub inside item_data
      const varObj = (firstVarId && variationObjects.get(firstVarId)) ?? firstEmbedded;
      const priceCents = extractPriceCents(varObj, locationId);

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

    const diagnostics = {
      scannedSquareObjects: objects.length,
      totalSquareItems: items.length,
      menuFilterApplied,
      menuFilteredItemCount,
      availableMenus: Array.from(menuItemIds.keys()),
      locationId: locationId ?? null,
      sampleVariationPricePath,
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
