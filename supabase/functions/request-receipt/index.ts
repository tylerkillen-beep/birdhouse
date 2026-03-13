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

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

function fail(message: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

function getBearerToken(req: Request) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

function getJwtSubUnsafe(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded);
    return typeof parsed?.sub === "string" ? parsed.sub : null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) return fail("Authentication required", 401);

    const { orderId } = await req.json();
    if (!orderId) return fail("Missing orderId", 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let userId = getJwtSubUnsafe(accessToken);

    if (!userId) {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(accessToken);

      if (authError || !user) {
        return fail("Invalid or expired session. Please sign in again.", 401);
      }
      userId = user.id;
    }

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, user_id, square_payment_id")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) {
      console.error("request-receipt: failed to load order", orderError, { orderId, userId });
      return fail("Could not load order", 500);
    }

    if (!order || order.user_id !== userId) {
      return fail("Order not found", 404);
    }

    if (!order.square_payment_id) {
      return fail("This order does not have a Square card payment receipt available.", 400);
    }

    const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
    if (!squareToken) return fail("Square credentials not configured", 500);

    const squareRes = await fetch(`${getSquareBaseUrl()}/v2/payments/${order.square_payment_id}`, {
      method: "GET",
      headers: {
        "Square-Version": "2024-01-18",
        "Authorization": `Bearer ${squareToken}`,
        "Content-Type": "application/json",
      },
    });

    const squareData = await squareRes.json();

    if (!squareRes.ok || squareData.errors?.length) {
      const err = squareData.errors?.[0];
      console.error("request-receipt: Square retrieve payment error", {
        orderId,
        squarePaymentId: order.square_payment_id,
        category: err?.category,
        code: err?.code,
        detail: err?.detail,
      });
      return fail(err?.detail || "Could not retrieve receipt from Square", 502);
    }

    const receiptUrl = squareData?.payment?.receipt_url || null;
    if (!receiptUrl) {
      return fail("Square did not return a receipt URL for this payment.", 404);
    }

    return ok({
      success: true,
      receiptUrl,
      message:
        "Square does not provide a reliable API to resend a payment receipt email later. Open this Square-hosted receipt link and share/email it from your device.",
    });
  } catch (err) {
    console.error("request-receipt error:", err);
    return fail(err instanceof Error ? err.message : "An unexpected error occurred", 500);
  }
});
