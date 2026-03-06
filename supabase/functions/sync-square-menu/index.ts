import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    const sqRes = await fetch(`${squareBaseUrl}/v2/catalog/list?types=ITEM,ITEM_VARIATION,CATEGORY`, {
      headers: {
        "Authorization": `Bearer ${squareToken}`,
        "Square-Version": "2024-01-18",
        "Content-Type": "application/json",
      },
    });

    const sqBody = await sqRes.json();
    if (!sqRes.ok || sqBody?.errors?.length) {
      return json({ success: false, error: sqBody?.errors?.[0]?.detail || "Square API error" }, 400);
    }

    const objects: SquareObject[] = sqBody.objects || [];
    const categories = new Map<string, string>();
    const variations = new Map<string, number>();

    for (const o of objects) {
      if (o.type === "CATEGORY") categories.set(o.id, o.category_data?.name || "Coffee");
      if (o.type === "ITEM_VARIATION") variations.set(o.id, o.item_variation_data?.price_money?.amount || 0);
    }

    const items = objects.filter((o) => o.type === "ITEM" && o.item_data?.name);
    let inserted = 0;
    let updated = 0;

    for (const item of items) {
      const firstVarId = item.item_data?.variations?.[0]?.id;
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

      const { data: existing } = await serviceClient
        .from("menu_items")
        .select("id")
        .eq("square_item_id", item.id)
        .maybeSingle();

      if (existing?.id) {
        const { error } = await serviceClient.from("menu_items").update(payload).eq("id", existing.id);
        if (!error) updated += 1;
      } else {
        const { data: maxSortRow } = await serviceClient
          .from("menu_items")
          .select("sort_order")
          .order("sort_order", { ascending: false })
          .limit(1)
          .maybeSingle();
        const sort_order = (maxSortRow?.sort_order || 0) + 1;
        const { error } = await serviceClient.from("menu_items").insert({ ...payload, sort_order, square_modifier_list_ids: [] });
        if (!error) inserted += 1;
      }
    }

    return json({ success: true, totalSquareItems: items.length, inserted, updated });
  } catch (e) {
    console.error("sync-square-menu error", e);
    return json({ success: false, error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
