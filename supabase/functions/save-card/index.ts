// Supabase Edge Function: save-card
// Deploy: supabase functions deploy save-card --no-verify-jwt
//
// Called at subscription signup. Creates a Square customer + saves a card on
// file, writes the subscription and drink slots, and charges the first week.
//
// Required Supabase secrets:
//   SQUARE_ACCESS_TOKEN  — access token from Square Developer Dashboard (matches environment)
//   SQUARE_LOCATION_ID   — your Square location ID (matches environment)
//   SQUARE_ENV           — "production" (default) or "sandbox"
//
// Why a card on file: the token subscribe.html gets from the Square Web
// Payments SDK is single-use and expires within minutes, so it cannot be
// charged again next week. It is exchanged here, once, for a Square customer
// and a stored card, and it is those two ids that charge-subscriptions bills
// every seventh day afterwards.
//
// This charges the first week immediately, which proves the card works before
// a student is enrolled and matches what "Start Subscription — $12/wk" implies
// at the moment they click. Set CHARGE_FIRST_WEEK_IMMEDIATELY to false to
// enroll on a free first week instead.
//
// Note that subscriptions.user_id is UNIQUE: a student has one subscription row
// for life, reused when they resubscribe. Nothing here may delete that row once
// it has history, because subscription_charges cascades from it.

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

/** A failure we understood, where no money moved. Deliberately distinct from a
 *  network failure, where the charge may well have gone through. */
class SignupFailed extends Error {}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // ── Manual JWT verification ───────────────────────────────────────────
    // This function deploys with --no-verify-jwt, so the token is checked here.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return fail("Missing or invalid authorization header", 401);
    }
    const userToken = authHeader.replace("Bearer ", "");

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${userToken}` } } }
    );

    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser();

    if (authError || !user) {
      console.error("Auth error:", authError);
      return fail("Unauthorized — invalid session", 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { sourceId, planId, discountPct, customerInfo, drinkSlots } = await req.json();

    const userId = user.id;
    if (!sourceId) throw new Error("Missing payment token");
    if (!planId) throw new Error("Missing plan");
    if (!drinkSlots?.length) throw new Error("At least one drink slot is required");
    if (!customerInfo?.email) throw new Error("Customer email is required");

    const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
    const locationId = Deno.env.get("SQUARE_LOCATION_ID");
    if (!squareToken || !locationId) throw new Error("Square credentials not configured");

    const SQ = `${getSquareBaseUrl()}/v2`;
    const sqHeaders = {
      "Square-Version": SQUARE_VERSION,
      "Authorization": `Bearer ${squareToken}`,
      "Content-Type": "application/json",
    };

    // ── 1. Check the plan and drinks before anything touches Square ───────
    // The price comes from the database, never the client. Checking first
    // means a rejected signup never leaves a stray card on file behind.
    const { data: plan, error: planError } = await supabase
      .from("subscription_plans")
      .select("*")
      .eq("id", planId)
      .single();

    if (planError || !plan) throw new Error("Invalid plan");
    if (!plan.active) throw new Error("That plan is no longer available");

    // A plan may be limited to drinks from chosen Square categories (empty
    // means every drink). subscribe.html only offers eligible drinks, but the
    // request body is the student's to edit, so this is the check that holds.
    const allowedCategoryIds: string[] = plan.allowed_square_category_ids || [];
    const drinkIds = [...new Set(drinkSlots.map((s: Record<string, unknown>) => s.drinkItemId))];
    if (drinkIds.some((id) => !id)) throw new Error("Please pick a drink for every slot");

    const { data: drinks, error: drinksError } = await supabase
      .from("menu_items")
      .select("id, name, available, square_category_ids")
      .in("id", drinkIds);
    if (drinksError) throw new Error("Could not check your drinks: " + drinksError.message);

    for (const drinkId of drinkIds) {
      const drink = drinks?.find((d) => d.id === drinkId);
      if (!drink?.available) {
        throw new Error("One of your drinks is no longer on the menu. Please pick another.");
      }
      const inPlan = !allowedCategoryIds.length ||
        (drink.square_category_ids || []).some((id: string) => allowedCategoryIds.includes(id));
      if (!inPlan) {
        throw new Error(`${drink.name} isn't included in the ${plan.name} plan. Please pick another drink.`);
      }
    }

    // Each plan includes a set number of free modifiers per drink (-1 means
    // unlimited). The weekly price is flat, so anything past that would be a
    // giveaway. subscribe.html blocks it; this catches a stale or crafted page.
    const freeModifierCount: number = plan.free_modifier_count ?? 0;
    if (freeModifierCount !== -1) {
      for (const slot of drinkSlots) {
        if ((slot.drinkModifiers?.length ?? 0) > freeModifierCount) {
          throw new Error(
            freeModifierCount === 0
              ? `The ${plan.name} plan doesn't include modifiers. Remove them and try again.`
              : `The ${plan.name} plan includes up to ${freeModifierCount} modifiers per drink.`
          );
        }
      }
    }

    const resolvedDiscountPct = Number(discountPct) || 0;
    const amountCents = amountForPlan(plan.price_cents, resolvedDiscountPct);

    // ── 2. Reuse this student's Square customer if they have one ──────────
    // subscriptions.user_id is unique, so there is at most one row to find.
    const { data: existingSub } = await supabase
      .from("subscriptions")
      .select("id, status, square_customer_id")
      .eq("user_id", userId)
      .maybeSingle();

    const isNewSubscription = !existingSub;
    const previousStatus = existingSub?.status ?? null;

    const createSquareCustomer = async (): Promise<string> => {
      const customerRes = await fetch(`${SQ}/customers`, {
        method: "POST",
        headers: sqHeaders,
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          given_name: customerInfo.firstName,
          family_name: customerInfo.lastName,
          email_address: customerInfo.email,
          reference_id: userId,
        }),
      });
      const customerData = await customerRes.json();
      if (customerData.errors?.length) {
        throw new Error("Failed to create Square customer: " + customerData.errors[0].detail);
      }
      return customerData.customer.id;
    };

    const createCardOnFile = async (customerId: string) => {
      const cardRes = await fetch(`${SQ}/cards`, {
        method: "POST",
        headers: sqHeaders,
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          source_id: sourceId,
          card: { customer_id: customerId },
        }),
      });
      return await cardRes.json();
    };

    /** Square customer ids belong to the environment that issued them, so an id
     *  saved while this function pointed at sandbox is meaningless in
     *  production. Square answers NOT_FOUND rather than anything more specific,
     *  so that is what we key off. */
    const customerMissing = (errors: Array<Record<string, string>> | undefined) =>
      !!errors?.some(
        (e) => e.code === "NOT_FOUND" || /customer with id .* not found/i.test(e.detail || "")
      );

    // ── 3. Save card to Square customer ───────────────────────────────────
    let squareCustomerId: string = existingSub?.square_customer_id || (await createSquareCustomer());
    let cardData = await createCardOnFile(squareCustomerId);

    if (cardData.errors?.length && existingSub?.square_customer_id && customerMissing(cardData.errors)) {
      // The stored id is stale — most likely left over from a sandbox signup.
      // Issue a fresh customer in the current environment and try once more.
      // The card token is untouched by a failed CreateCard, so it is still good.
      console.warn("Stored Square customer not found in this environment; recreating.", {
        userId,
        staleCustomerId: existingSub.square_customer_id,
      });
      squareCustomerId = await createSquareCustomer();
      cardData = await createCardOnFile(squareCustomerId);
    }

    if (cardData.errors?.length) {
      throw new Error("Failed to save card: " + cardData.errors[0].detail);
    }
    const squareCardId: string = cardData.card.id;

    const firstBillingDate = localToday();

    // ── 4. Upsert subscription record ─────────────────────────────────────
    // next_billing_date is provisional; it only moves forward once the first
    // charge clears.
    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .upsert(
        {
          user_id: userId,
          plan_id: planId,
          status: "active",
          billing_interval: "week",
          square_customer_id: squareCustomerId,
          square_card_id: squareCardId,
          next_billing_date: firstBillingDate,
          renewal_date: firstBillingDate,
          discount_pct: resolvedDiscountPct,
          failed_charge_count: 0,
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (subError) throw new Error("Failed to save subscription: " + subError.message);

    const subscriptionId = subscription.id;

    /** Undo as much as is safe. A brand-new subscription can be deleted
     *  outright; an existing one must not be, because subscription_charges
     *  cascades from it and that is the student's billing history. */
    const rollback = async () => {
      if (isNewSubscription) {
        await supabase.from("subscriptions").delete().eq("id", subscriptionId);
      } else {
        await supabase
          .from("subscriptions")
          .update({ status: previousStatus ?? "cancelled" })
          .eq("id", subscriptionId);
      }
    };

    try {
      // ── 5. Upsert drink slots ───────────────────────────────────────────
      for (const slot of drinkSlots) {
        const { error: slotError } = await supabase
          .from("subscription_drink_slots")
          .upsert(
            {
              subscription_id: subscriptionId,
              slot_number: slot.slotNumber,
              drink_item_id: slot.drinkItemId,
              drink_modifiers: slot.drinkModifiers || [],
              delivery_day: slot.deliveryDay,
              delivery_time: slot.deliveryTime,
              delivery_location: slot.deliveryLocation,
            },
            { onConflict: "subscription_id,slot_number" }
          );
        if (slotError) {
          // The delivery-slot trigger raises plain exceptions (P0001) whose
          // text is written for the customer, e.g. a time that is full.
          throw new SignupFailed(
            slotError.code === "P0001"
              ? slotError.message
              : "Failed to save drink slot: " + slotError.message
          );
        }
      }

      // Dropping from two drinks a week to one would otherwise leave the old
      // second slot behind, still being delivered.
      const keptSlotNumbers = drinkSlots.map((s: Record<string, unknown>) => s.slotNumber);
      await supabase
        .from("subscription_drink_slots")
        .delete()
        .eq("subscription_id", subscriptionId)
        .not("slot_number", "in", `(${keptSlotNumbers.join(",")})`);

      // ── 6. Charge the first week ────────────────────────────────────────
      let alreadyPaidForToday = false;

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
          // Unique (subscription_id, billing_date) — someone already billed
          // this student today. Resubscribing twice in one day must not charge
          // twice.
          const { data: prior } = await supabase
            .from("subscription_charges")
            .select("status")
            .eq("subscription_id", subscriptionId)
            .eq("billing_date", firstBillingDate)
            .maybeSingle();

          if (prior?.status === "succeeded") {
            alreadyPaidForToday = true;
          } else if (prior?.status === "pending") {
            throw new SignupFailed(
              "A payment for today is already being processed. Check your dashboard in a moment."
            );
          } else {
            await supabase
              .from("subscription_charges")
              .update({
                status: "pending",
                amount_cents: amountCents,
                updated_at: new Date().toISOString(),
              })
              .eq("subscription_id", subscriptionId)
              .eq("billing_date", firstBillingDate);
          }
        }

        if (!alreadyPaidForToday) {
          let paymentData: Record<string, any>;

          try {
            const paymentRes = await fetch(`${SQ}/payments`, {
              method: "POST",
              headers: sqHeaders,
              body: JSON.stringify({
                source_id: squareCardId,
                customer_id: squareCustomerId,
                idempotency_key: idempotencyKey,
                amount_money: { amount: amountCents, currency: "USD" },
                location_id: locationId,
                buyer_email_address: customerInfo.email,
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
            // happened, so the subscription is flagged rather than rolled back
            // and the pending ledger row is left for reconciliation. Undoing
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
              error_detail: null,
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
      }

      // ── 7. Start the weekly clock ───────────────────────────────────────
      const nextBillingDate = addDays(firstBillingDate, BILLING_INTERVAL_DAYS);

      await supabase
        .from("subscriptions")
        .update({
          next_billing_date: nextBillingDate,
          renewal_date: nextBillingDate,
          last_charged_at:
            CHARGE_FIRST_WEEK_IMMEDIATELY && amountCents > 0 ? new Date().toISOString() : null,
        })
        .eq("id", subscriptionId);

      // ── 8. Log the event ────────────────────────────────────────────────
      await supabase.from("subscription_events").insert({
        subscription_id: subscriptionId,
        event_type: isNewSubscription ? "created" : "card_updated",
        note: `Plan: ${plan.name} — billed weekly${
          resolvedDiscountPct ? ` — ${resolvedDiscountPct}% teacher discount` : ""
        }`,
      });

      return ok({ success: true, subscriptionId, nextBillingDate });
    } catch (err) {
      if (err instanceof SignupFailed) {
        await rollback();
        return fail(err.message);
      }
      throw err;
    }
  } catch (err) {
    console.error("save-card error:", err);
    return fail(err instanceof Error ? err.message : "An unexpected error occurred");
  }
});
