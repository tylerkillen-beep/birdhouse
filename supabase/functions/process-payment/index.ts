// Supabase Edge Function: process-payment
// Handles Square payments for multi-item Birdhouse orders.
//
// Required Supabase secrets (set via: supabase secrets set KEY=value):
//   SQUARE_ACCESS_TOKEN  — access token from Square Developer Dashboard (matches environment)
//   SQUARE_LOCATION_ID   — your Square location ID (matches environment)
//
// The function receives the Square card token from the frontend, charges the
// card for the full cart total (minus any loyalty credit applied), records the
// order in the `orders` table, and updates the customer's loyalty metadata.
//
// Loyalty system:
//   - $25 spent on menu orders (non-subscription) earns a $3 credit
//   - Credits accumulate; multiple can be used at once
//   - Subscriptions are excluded from earning and using credits
//   - User metadata fields: loyalty_spend_cents (cumulative), loyalty_credit_cents (available)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

// Loyalty constants
const SPEND_THRESHOLD_CENTS = 2500; // $25.00
const CREDIT_REWARD_CENTS   = 300;  // $3.00

// Sticker sheet pricing.  The first uploaded image on each sheet is free;
// repeating that image across slots costs nothing extra.
const STICKER_SHEET_CENTS       = 200; // $2.00 per printed 4x7 sheet
const STICKER_EXTRA_IMAGE_CENTS = 25;  // $0.25 per unique image after the first
const MAX_IMAGES_PER_SHEET      = 16;
const MAX_SHEETS_PER_ORDER      = 10;

// The school runs on Central time; edge functions run on UTC.  Every date the
// customer sees is a local calendar date, so normalize through this zone.
const SCHOOL_TIME_ZONE = "America/Chicago";

/** Today's local calendar date at the school, as YYYY-MM-DD. */
function localToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHOOL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function isWeekend(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

/** Earliest date a sticker sheet can be delivered: tomorrow, skipping weekends
 *  and anything on the blocked_dates calendar. */
function nextSchoolDay(blocked: Set<string>): string {
  let cursor = addDays(localToday(), 1);
  for (let i = 0; i < 30; i++) {
    if (!isWeekend(cursor) && !blocked.has(cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const {
      sourceId,
      cartItems,
      userId,
      customerInfo,
      creditUsedCents: rawCreditUsed,
      deliveryMethod,
      orderType: rawOrderType,
      sheetIds,
    } = await req.json();

    const orderType = rawOrderType === "stickers" ? "stickers" : "menu";
    const isStickerOrder = orderType === "stickers";

    // ── Validate auth ──────────────────────────────────────────────────────
    const accessToken = getBearerToken(req);
    if (!accessToken) return fail("Authentication required", 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      return fail("Invalid or expired session. Please sign in again.", 401);
    }

    const isAnonymousUser = (user as { is_anonymous?: boolean }).is_anonymous === true;
    if (isAnonymousUser) {
      return fail("Please sign in before placing an order.", 401);
    }

    // Prefer authenticated email, with customer payload as a fallback.
    // Square only sends receipt emails when buyer_email_address is present.
    const buyerEmail = (user.email || customerInfo?.email || "").trim().toLowerCase() || null;

    // ── Validate inputs ────────────────────────────────────────────────────
    if (!sourceId) throw new Error("Missing payment token");
    if (!userId) throw new Error("User not authenticated");
    if (user.id !== userId) return fail("User mismatch", 403);
    if (!customerInfo?.room) throw new Error("Delivery location is required");

    if (!isStickerOrder) {
      if (!cartItems?.length) throw new Error("Cart is empty");
    } else {
      if (!sheetIds?.length) throw new Error("No sticker sheets to order");
      if (sheetIds.length > MAX_SHEETS_PER_ORDER) {
        throw new Error(`Please order at most ${MAX_SHEETS_PER_ORDER} sheets at a time`);
      }

      // Sheets need at least half a day of print time, so the earliest delivery
      // is the next school day.  The client's date picker already enforces this;
      // re-check here so a crafted request cannot skip the queue.
      const { data: blocked } = await supabase.from("blocked_dates").select("date");
      const blockedSet = new Set((blocked || []).map((b: { date: string }) => b.date));
      const earliest = nextSchoolDay(blockedSet);

      if (!customerInfo.deliveryDate) {
        throw new Error("Delivery date is required");
      }
      if (customerInfo.deliveryDate < earliest) {
        throw new Error(
          `Sticker sheets need at least half a day to print. The earliest delivery is ${earliest}.`
        );
      }
      if (blockedSet.has(customerInfo.deliveryDate) || isWeekend(customerInfo.deliveryDate)) {
        throw new Error("We are closed on that date — please pick another day.");
      }
    }

    const orderDeliveryMethod = (deliveryMethod === 'pickup') ? 'pickup' : 'delivery';

    // Teachers and staff always get free delivery; other students pay $1
    const isTeacherEmail = (user.email || '').endsWith('@nixaschools.net');
    const { data: staffRecord } = await supabase
      .from("students")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    const isStaff = ['student', 'manager', 'admin'].includes(staffRecord?.role);
    const deliveryFeeCents = (!isTeacherEmail && !isStaff && orderDeliveryMethod === 'delivery') ? 100 : 0;

    // ── Calculate order total ──────────────────────────────────────────────
    interface CartItem {
      id: string;
      name: string;
      temp?: "hot" | "iced";
      price: number;
      quantity: number;
      type?: string;
      sheetId?: string;
      layoutPreset?: string;
      uniqueImageCount?: number;
      placedCount?: number;
    }

    interface StickerSheetRow {
      id: string;
      user_id: string;
      status: string;
      layout_preset: string;
      unique_image_count: number;
      placed_count: number;
      print_path: string | null;
    }

    let items: CartItem[];
    let itemsTotalCents: number;
    let stickerSheets: StickerSheetRow[] = [];

    if (isStickerOrder) {
      // Price from the stored sheets, never from the client.  Only the buyer's
      // own untouched drafts are eligible, so a paid sheet cannot be re-used.
      const { data: sheetRows, error: sheetErr } = await supabase
        .from("sticker_sheets")
        .select("id, user_id, status, layout_preset, unique_image_count, placed_count, print_path")
        .in("id", sheetIds)
        .eq("user_id", user.id)
        .eq("status", "draft");

      if (sheetErr) throw new Error("Could not load your sticker sheets — please try again");

      stickerSheets = (sheetRows || []) as StickerSheetRow[];

      if (stickerSheets.length !== sheetIds.length) {
        throw new Error(
          "One of your sheets is no longer available for checkout. Refresh the page and try again."
        );
      }

      for (const sheet of stickerSheets) {
        if (!sheet.print_path) {
          throw new Error("A sheet is still finishing its print file — wait a moment and try again");
        }
        if (sheet.placed_count < 1) {
          throw new Error("Every sheet needs at least one sticker on it");
        }
        if (sheet.placed_count > MAX_IMAGES_PER_SHEET || sheet.unique_image_count > MAX_IMAGES_PER_SHEET) {
          throw new Error(`A sheet holds at most ${MAX_IMAGES_PER_SHEET} stickers`);
        }
        if (sheet.unique_image_count > sheet.placed_count) {
          throw new Error("Sheet is inconsistent — please rebuild it");
        }
      }

      items = stickerSheets.map((sheet) => {
        const extraImages = Math.max(0, sheet.unique_image_count - 1);
        const sheetCents  = STICKER_SHEET_CENTS + extraImages * STICKER_EXTRA_IMAGE_CENTS;
        return {
          id:               sheet.id,
          type:             "sticker_sheet",
          name:             `Sticker sheet — ${sheet.placed_count} sticker${sheet.placed_count === 1 ? "" : "s"}`,
          price:            sheetCents / 100,
          quantity:         1,
          sheetId:          sheet.id,
          layoutPreset:     sheet.layout_preset,
          uniqueImageCount: sheet.unique_image_count,
          placedCount:      sheet.placed_count,
        };
      });

      itemsTotalCents = stickerSheets.reduce(
        (sum, sheet) =>
          sum + STICKER_SHEET_CENTS + Math.max(0, sheet.unique_image_count - 1) * STICKER_EXTRA_IMAGE_CENTS,
        0
      );
    } else {
      items = cartItems;
      itemsTotalCents = Math.round(
        items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100
      );
    }

    const orderTotalCents = itemsTotalCents + deliveryFeeCents;

    if (orderTotalCents <= 0) throw new Error("Order total must be greater than zero");

    // ── Validate and apply loyalty credit ─────────────────────────────────
    // Read authoritative loyalty state from the profiles table.  user_metadata
    // can be stale or absent for accounts that predate the loyalty system;
    // profiles is the canonical source kept in sync by this function and
    // backfilled from historical orders via migration.
    const meta = user.user_metadata || {};
    const { data: profileLoyalty } = await supabase
      .from("profiles")
      .select("loyalty_spend_cents, loyalty_credit_cents, location")
      .eq("id", user.id)
      .maybeSingle();

    const availableCreditCents: number =
      profileLoyalty?.loyalty_credit_cents ?? meta.loyalty_credit_cents ?? 0;

    const creditUsedCents = Math.max(0, Math.min(
      Math.round(rawCreditUsed || 0),
      availableCreditCents,
      orderTotalCents
    ));

    const chargeAmountCents = orderTotalCents - creditUsedCents;

    // ── Charge via Square (skip if fully covered by credit) ────────────────
    let squarePaymentId: string | null = null;

    if (chargeAmountCents > 0) {
      const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
      const locationId = Deno.env.get("SQUARE_LOCATION_ID");

      if (!squareToken || !locationId) {
        throw new Error("Square credentials not configured — contact admin");
      }

      const squareBaseUrl = getSquareBaseUrl();

      if (!buyerEmail) {
        console.warn("process-payment: buyer email missing, Square receipt email may not be sent", {
          userId,
          squareEnv: Deno.env.get("SQUARE_ENV") || "production",
        });
      }

      const squareRes = await fetch(`${squareBaseUrl}/v2/payments`, {
        method: "POST",
        headers: {
          "Square-Version": "2024-01-18",
          "Authorization": `Bearer ${squareToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_id: sourceId,
          idempotency_key: crypto.randomUUID(),
          amount_money: { amount: chargeAmountCents, currency: "USD" },
          location_id: locationId,
          ...(buyerEmail ? { buyer_email_address: buyerEmail } : {}),
          note: `Birdhouse — ${customerInfo.customerName} — ${orderDeliveryMethod === 'pickup' ? 'Pickup' : `Room ${customerInfo.room}`}`,
        }),
      });

      const squareData = await squareRes.json();

      if (!squareRes.ok || squareData.errors?.length) {
        const err = squareData.errors?.[0];
        console.error("Square payment error:", {
          category: err?.category,
          code: err?.code,
          detail: err?.detail,
          field: err?.field,
          squareEnv: Deno.env.get("SQUARE_ENV") || "production",
          locationId,
        });

        if (err?.category === "AUTHENTICATION_ERROR") {
          throw new Error(
            "Square credentials are misconfigured. Check SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, and SQUARE_ENV in Supabase secrets."
          );
        }

        throw new Error(err?.detail ?? "Payment declined");
      }

      squarePaymentId = squareData.payment.id;
    }

    // ── Insert order into Supabase ─────────────────────────────────────────
    const totalAmount = orderTotalCents / 100;

    const drinkName = isStickerOrder
      ? `${items.length} sticker sheet${items.length === 1 ? "" : "s"}`
      : items.length === 1
        ? `${items[0].name} (${items[0].temp === "iced" ? "Iced" : "Hot"})`
        : `${items[0].name} + ${items.length - 1} more item${items.length > 2 ? "s" : ""}`;

    const itemName = items.map(i => i.name).join(', ');

    const { data: order, error: dbError } = await supabase
      .from("orders")
      .insert({
        user_id: userId,
        customer_name: customerInfo.customerName || null,
        drink_name: drinkName,
        item_name: itemName,
        cart_items: items,
        total_amount: totalAmount,
        room: customerInfo.room,
        delivery_day: customerInfo.deliveryDay,
        delivery_date: customerInfo.deliveryDate || null,
        delivery_time: customerInfo.deliveryTime,
        special_instructions: customerInfo.notes || null,
        // Derive location from the authenticated profile (server-side) so the
        // order queue always shows the correct campus regardless of what the
        // client sends.  Teachers default to 'high_school' in profiles, so this
        // correctly distinguishes Mathews from high-school orders.
        customer_location: isTeacherEmail
          ? (profileLoyalty?.location === 'mathews' ? 'mathews' : 'teacher')
          : 'student',
        status: "paid",
        points_earned: 0,
        credit_used_cents: creditUsedCents,
        square_payment_id: squarePaymentId,
        delivery_method: orderDeliveryMethod,
        order_type: orderType,
      })
      .select()
      .single();

    if (dbError) {
      console.error("DB insert failed after successful payment:", dbError, {
        squarePaymentId,
        userId,
        totalAmount,
      });
      // Still update loyalty even if order record fails
    }

    // Hand the paid sheets to the print queue.  This also locks them: the
    // customer's RLS update policy only covers rows still in 'draft'.
    if (isStickerOrder && stickerSheets.length) {
      for (const sheet of stickerSheets) {
        const extraImages = Math.max(0, sheet.unique_image_count - 1);
        const { error: sheetUpdateErr } = await supabase
          .from("sticker_sheets")
          .update({
            status:      "pending_review",
            order_id:    order?.id ?? null,
            price_cents: STICKER_SHEET_CENTS + extraImages * STICKER_EXTRA_IMAGE_CENTS,
          })
          .eq("id", sheet.id)
          .eq("status", "draft");

        if (sheetUpdateErr) {
          console.error("Sticker sheet did not reach the print queue:", sheetUpdateErr, {
            sheetId: sheet.id,
            orderId: order?.id,
            squarePaymentId,
          });
        }
      }
    }

    // ── Update loyalty metadata ────────────────────────────────────────────
    // Spend tracks the full order total (pre-credit) so using credits doesn't
    // slow down future earning.  Use the profiles value (authoritative) as the
    // baseline so historical orders are counted correctly.
    const oldSpendCents: number =
      profileLoyalty?.loyalty_spend_cents ?? meta.loyalty_spend_cents ?? 0;
    const newSpendCents = oldSpendCents + orderTotalCents;

    const creditsAlreadyEarned = Math.floor(oldSpendCents / SPEND_THRESHOLD_CENTS) * CREDIT_REWARD_CENTS;
    const creditsNowEarned     = Math.floor(newSpendCents / SPEND_THRESHOLD_CENTS) * CREDIT_REWARD_CENTS;
    const newCreditsAwarded    = creditsNowEarned - creditsAlreadyEarned;

    const newCreditBalance = Math.max(0, availableCreditCents - creditUsedCents + newCreditsAwarded);

    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...meta,
        loyalty_spend_cents:  newSpendCents,
        loyalty_credit_cents: newCreditBalance,
        // Clear old points field so the UI doesn't show stale data
        loyalty_points: undefined,
      },
    });

    // Sync loyalty totals to profiles table so the admin panel can display them
    await supabase
      .from("profiles")
      .upsert(
        { id: userId, loyalty_spend_cents: newSpendCents, loyalty_credit_cents: newCreditBalance },
        { onConflict: "id" }
      );

    return ok({
      success: true,
      orderId: order?.id ?? null,
      ...(dbError ? { warning: "Payment accepted — order may take a moment to appear. Contact staff if it doesn't." } : {}),
      loyaltyUpdate: {
        newSpendCents,
        newCreditBalance,
        newCreditsAwarded,
      },
    });
  } catch (err) {
    console.error("process-payment error:", err);
    return fail(err instanceof Error ? err.message : "An unexpected error occurred");
  }
});
