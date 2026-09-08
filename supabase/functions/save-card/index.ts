// Supabase Edge Function: save-card
// Starts a weekly drink subscription for a student or teacher.
//
// Required Supabase secrets (set via: supabase secrets set KEY=value):
//   SQUARE_ACCESS_TOKEN  — access token from Square Developer Dashboard (matches environment)
//   SQUARE_LOCATION_ID   — your Square location ID (matches environment)
//   SQUARE_ENV           — "production" (default) or "sandbox"
//
// Why this function exists at all: the token subscribe.html gets back from the
// Square Web Payments SDK is single-use and expires within minutes. It cannot
// be charged again next week. So the token is exchanged here, once, for a
// Square customer and a card on file, and it is those two ids — not the token —
// that charge-subscriptions bills every week afterwards.
//
// This function charges the first week immediately. That is deliberate: it
// proves the card works before a student is enrolled, and it matches what
// "Start Subscription — $12/wk" implies at the moment they click it. Set
// CHARGE_FIRST_WEEK_IMMEDIATELY to false to enroll on a free first week
// instead, in which case the first charge lands seven days later.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

const SQUARE_VERSION = "2024-01-18";

const CHARGE_FIRST_WEEK_IMMEDIATELY = true;

const BILLING_INTERVAL_DAYS = 7;

// The school runs on Central time; edge functions run on UTC. Every date the
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

/** Square caps idempotency keys at 45 characters, so the uuid loses its dashes.
 *  The same subscription and billing date always produce the same key, which is
 *  what makes a retry safe: Square returns the original payment instead of
 *  taking the money twice. */
function chargeIdempotencyKey(subscriptionId: string, billingDate: string) {
  return `${subscriptionId.replace(/-/g, "")}-${billingDate.replace(/-/g, "")}`;
}

/** Price after the teacher discount, in whole cents. */
function amountForPlan(priceCents: number, discountPct: number) {
  const pct = Math.min(100, Math.max(0, discountPct || 0));
  return Math.round(priceCents * (1 - pct / 100));
}

/** A Square error we received and understood: the charge definitively did not
 *  happen, so rolling the signup back is safe. Deliberately distinct from a
 *  network failure, where the charge may well have gone through. */
class SignupFailed extends Error {}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { sourceId, userId, planId, discountPct, customerInfo, drinkSlots } = await req.json();

    if (!sourceId) return fail("Missing card details");
    if (!planId) return fail("Missing plan");
    if (!Array.isArray(drinkSlots) || drinkSlots.length === 0) {
      return fail("Pick at least one drink");
    }

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

    if (authError || !user) return fail("Authentication required", 401);
    // The client sends userId, but the token is the only thing we trust.
    if (userId && userId !== user.id) return fail("Authentication required", 401);

    const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
    const locationId = Deno.env.get("SQUARE_LOCATION_ID");
    if (!squareToken || !locationId) {
      return fail("Square credentials not configured — contact admin", 500);
    }
    const squareBaseUrl = getSquareBaseUrl();

    // ── One live subscription per person ───────────────────────────────────
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("id, status")
      .eq("user_id", user.id)
      .in("status", ["active", "paused"])
      .maybeSingle();

    if (existing) {
      return fail(
        "You already have a subscription. Manage it from your dashboard instead of starting a new one."
      );
    }

    // ── Load the plan; the price comes from the database, never the client ──
    const { data: plan, error: planError } = await supabase
      .from("subscription_plans")
      .select("id, name, price_cents, active")
      .eq("id", planId)
      .single();

    if (planError || !plan) return fail("That plan is no longer available");
    if (!plan.active) return fail("That plan is no longer available");

    const discount = Number(discountPct) || 0;
    const amountCents = amountForPlan(plan.price_cents, discount);

    const squareHeaders = {
      "Square-Version": SQUARE_VERSION,
      "Authorization": `Bearer ${squareToken}`,
      "Content-Type": "application/json",
    };

    // ── Square: customer, then card on file ────────────────────────────────
    const customerRes = await fetch(`${squareBaseUrl}/v2/customers`, {
      method: "POST",
      headers: squareHeaders,
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        given_name: customerInfo?.firstName || "",
        family_name: customerInfo?.lastName || "",
        email_address: customerInfo?.email || user.email || "",
        reference_id: user.id,
        note: "Birdhouse subscription",
      }),
    });

    const customerData = await customerRes.json();
    if (!customerRes.ok || customerData.errors?.length) {
      console.error("Square create customer failed:", customerData.errors);
      return fail(
        customerData.errors?.[0]?.detail ?? "Could not set up billing. Please try again."
      );
    }
    const squareCustomerId = customerData.customer.id;

    const cardRes = await fetch(`${squareBaseUrl}/v2/cards`, {
      method: "POST",
      headers: squareHeaders,
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        source_id: sourceId,
        card: {
          customer_id: squareCustomerId,
          cardholder_name: `${customerInfo?.firstName || ""} ${customerInfo?.lastName || ""}`.trim(),
        },
      }),
    });

    const cardData = await cardRes.json();
    if (!cardRes.ok || cardData.errors?.length) {
      console.error("Square create card failed:", cardData.errors);
      return fail(
        cardData.errors?.[0]?.detail ??
          "That card could not be saved. Please check the details and try again."
      );
    }
    const squareCardId = cardData.card.id;

    // ── Create the subscription ────────────────────────────────────────────
    const firstBillingDate = localToday();

    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .insert({
        user_id: user.id,
        plan_id: plan.id,
        status: "active",
        billing_interval: "week",
        discount_pct: discount,
        square_customer_id: squareCustomerId,
        square_card_id: squareCardId,
        // Provisional. This only moves forward once the first charge clears.
        next_billing_date: firstBillingDate,
        renewal_date: firstBillingDate,
      })
      .select("id")
      .single();

    if (subError || !subscription) {
      console.error("Subscription insert failed:", subError);
      return fail("Could not start your subscription. Please try again.");
    }

    const subscriptionId = subscription.id;

    try {
      const slotRows = drinkSlots.map((s: Record<string, unknown>) => ({
        subscription_id: subscriptionId,
        slot_number: s.slotNumber,
        menu_item_id: s.drinkItemId,
        drink_modifiers: s.drinkModifiers ?? [],
        delivery_day: s.deliveryDay,
        delivery_time: s.deliveryTime,
        delivery_location: s.deliveryLocation,
      }));

      const { error: slotError } = await supabase
        .from("subscription_drink_slots")
        .insert(slotRows);

      if (slotError) {
        console.error("Drink slot insert failed:", slotError);
        throw new SignupFailed("Could not save your drink choices. Please try again.");
      }

      if (CHARGE_FIRST_WEEK_IMMEDIATELY && amountCents > 0) {
        const idempotencyKey = chargeIdempotencyKey(subscriptionId, firstBillingDate);

        // The ledger row goes in before the money moves. If this function dies
        // mid-charge, that pending row is the record that something may have
        // been billed and needs reconciling.
        const { error: ledgerError } = await supabase.from("subscription_charges").insert({
          subscription_id: subscriptionId,
          billing_date: firstBillingDate,
          amount_cents: amountCents,
          status: "pending",
          idempotency_key: idempotencyKey,
        });

        if (ledgerError) {
          console.error("Charge ledger insert failed:", ledgerError);
          throw new SignupFailed("Could not start your subscription. Please try again.");
        }

        let paymentData: Record<string, any>;

        try {
          const paymentRes = await fetch(`${squareBaseUrl}/v2/payments`, {
            method: "POST",
            headers: squareHeaders,
            body: JSON.stringify({
              source_id: squareCardId,
              customer_id: squareCustomerId,
              idempotency_key: idempotencyKey,
              amount_money: { amount: amountCents, currency: "USD" },
              location_id: locationId,
              ...(customerInfo?.email ? { buyer_email_address: customerInfo.email } : {}),
              note: `Birdhouse Subscription — ${plan.name} — week of ${firstBillingDate}`,
            }),
          });

          paymentData = await paymentRes.json();

          if (!paymentRes.ok || paymentData.errors?.length) {
            const err = paymentData.errors?.[0];
            console.error("Square subscription charge error:", {
              category: err?.category,
              code: err?.code,
              detail: err?.detail,
              subscriptionId,
            });

            await supabase
              .from("subscription_charges")
              .update({
                status: "failed",
                error_detail: err?.detail ?? "Declined",
                updated_at: new Date().toISOString(),
              })
              .eq("subscription_id", subscriptionId)
              .eq("billing_date", firstBillingDate);

            throw new SignupFailed(
              err?.detail ?? "Your card was declined. Please try a different card."
            );
          }
        } catch (netErr) {
          if (netErr instanceof SignupFailed) throw netErr;

          // We never heard back from Square. The charge may or may not have
          // happened, so the subscription is flagged rather than deleted and
          // the pending ledger row is left for reconciliation. Rolling back
          // here could hide a real charge.
          console.error("Square unreachable during first charge:", netErr, { subscriptionId });
          await supabase
            .from("subscriptions")
            .update({ status: "payment_failed" })
            .eq("id", subscriptionId);

          return fail(
            "We could not confirm your payment. Please do not try again — check your dashboard in a few minutes or contact the Birdhouse team."
          );
        }

        await supabase
          .from("subscription_charges")
          .update({
            status: "succeeded",
            square_payment_id: paymentData.payment?.id ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("subscription_id", subscriptionId)
          .eq("billing_date", firstBillingDate);

        await supabase.from("subscription_events").insert({
          subscription_id: subscriptionId,
          event_type: "charged",
          amount_cents: amountCents,
          note: `First week — ${plan.name}`,
        });
      }

      // Only now does the clock start: the next charge is a week out.
      const nextBillingDate = addDays(firstBillingDate, BILLING_INTERVAL_DAYS);

      await supabase
        .from("subscriptions")
        .update({
          next_billing_date: nextBillingDate,
          renewal_date: nextBillingDate,
          last_charged_at: CHARGE_FIRST_WEEK_IMMEDIATELY ? new Date().toISOString() : null,
        })
        .eq("id", subscriptionId);

      await supabase.from("subscription_events").insert({
        subscription_id: subscriptionId,
        event_type: "created",
        note: `${plan.name} — billed weekly`,
      });

      return ok({ success: true, subscriptionId, nextBillingDate });
    } catch (err) {
      if (err instanceof SignupFailed) {
        // Nothing was charged, so leave no half-built subscription behind.
        // Slots and ledger rows cascade with the row.
        await supabase.from("subscriptions").delete().eq("id", subscriptionId);
        return fail(err.message);
      }
      throw err;
    }
  } catch (err) {
    console.error("save-card unexpected error:", err);
    return fail(err instanceof Error ? err.message : "Something went wrong", 500);
  }
});
