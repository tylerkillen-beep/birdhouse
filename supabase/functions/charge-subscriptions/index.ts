// Supabase Edge Function: charge-subscriptions
// Bills every subscription that is due, using the card save-card stored.
//
// Required Supabase secrets (set via: supabase secrets set KEY=value):
//   SQUARE_ACCESS_TOKEN  — access token from Square Developer Dashboard (matches environment)
//   SQUARE_LOCATION_ID   — your Square location ID (matches environment)
//   SQUARE_ENV           — "production" (default) or "sandbox"
//   CRON_SECRET          — long random string; the caller must send it
//
// This runs once a day rather than once a week. It charges a subscription only
// when next_billing_date has arrived, so a daily run bills each student every
// seventh day and a missed day is picked up the next morning instead of
// skipping someone's week entirely.
//
// Call it with:
//   POST /functions/v1/charge-subscriptions
//   Header: x-cron-secret: <CRON_SECRET>
//   Body (optional): { "dryRun": true }
//
// A dry run reports exactly who would be charged and how much, and touches
// nothing. Always dry run first after changing prices.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

const SQUARE_VERSION = "2024-01-18";

const BILLING_INTERVAL_DAYS = 7;

// How many consecutive failures before a subscription stops being retried and
// is handed to a human. Three daily attempts covers the usual "card expired
// over the weekend" case without hammering someone's declined card for weeks.
const MAX_FAILED_ATTEMPTS = 3;

// If a subscription is more than this many days overdue, do not charge it.
// A subscription left active over spring break or summer should not surprise a
// student with a charge for a week they never drank; it is re-anchored to the
// next upcoming billing date and flagged instead.
const MAX_ARREARS_DAYS = 14;

// A subscriber is not billed for a week in which every one of their delivery
// days is closed, so summer would otherwise step forward one week per run
// forever. This caps how far a single subscription can jump ahead in one go —
// about two months, comfortably more than the longest school break.
const MAX_SKIPPED_WEEKS = 10;

// Ceiling on one run, so a bad query can never turn into hundreds of charges.
const MAX_CHARGES_PER_RUN = 200;

// The school runs on Central time; edge functions run on UTC.
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

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86400000);
}

/** The next billing date strictly after today, stepping a week at a time from
 *  the date that was due. Stepping from the scheduled date rather than from
 *  today is what keeps a subscription on the same weekday forever instead of
 *  drifting every time a run is late. */
function advanceBillingDate(fromDate: string, today: string): string {
  let next = addDays(fromDate, BILLING_INTERVAL_DAYS);
  while (daysBetween(next, today) >= 0) {
    next = addDays(next, BILLING_INTERVAL_DAYS);
  }
  return next;
}

const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The date a "Wednesday" delivery lands on for the service week that starts on
 *  billingDate. Any 7-day window contains each weekday exactly once, so this is
 *  unambiguous. */
function deliveryDateInWeek(billingDate: string, dayName: string): string | null {
  const target = DAY_INDEX[(dayName || "").trim().toLowerCase()];
  if (target === undefined) return null;
  const offset = (target - dayOfWeek(billingDate) + 7) % 7;
  return addDays(billingDate, offset);
}

/** True when this subscriber would receive nothing at all during the week
 *  beginning on billingDate, because every one of their delivery days falls on
 *  a closed date.
 *
 *  Charging is the default: with no slots, or a delivery day we cannot parse,
 *  this returns false. Skipping someone's payment needs positive evidence that
 *  they get nothing, never an absence of evidence that they get something. */
function weekIsFullyClosed(
  billingDate: string,
  deliveryDays: string[],
  closedDates: Set<string>
): boolean {
  if (!deliveryDays.length) return false;
  const dates = deliveryDays.map((d) => deliveryDateInWeek(billingDate, d));
  if (dates.some((d) => d === null)) return false;
  return dates.every((d) => closedDates.has(d as string));
}

/** Step past every week the subscriber would receive nothing, a week at a time.
 *  A two-week break is skipped entirely in a single run, and the weekday anchor
 *  is preserved because each step is exactly seven days. */
function skipClosedWeeks(
  billingDate: string,
  deliveryDays: string[],
  closedDates: Set<string>
): { billingDate: string; skippedWeeks: number } {
  let cursor = billingDate;
  let skippedWeeks = 0;
  while (
    skippedWeeks < MAX_SKIPPED_WEEKS &&
    weekIsFullyClosed(cursor, deliveryDays, closedDates)
  ) {
    cursor = addDays(cursor, BILLING_INTERVAL_DAYS);
    skippedWeeks++;
  }
  return { billingDate: cursor, skippedWeeks };
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
 *  The same subscription and billing date always produce the same key, so if a
 *  run times out after Square accepted the payment, the retry returns that same
 *  payment instead of taking the money twice. */
function chargeIdempotencyKey(subscriptionId: string, billingDate: string) {
  return `${subscriptionId.replace(/-/g, "")}-${billingDate.replace(/-/g, "")}`;
}

/** Price after the teacher discount, in whole cents. */
function amountForPlan(priceCents: number, discountPct: number) {
  const pct = Math.min(100, Math.max(0, discountPct || 0));
  return Math.round(priceCents * (1 - pct / 100));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // ── Auth: a shared secret, because the caller is a cron job, not a person ─
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) {
    console.error("CRON_SECRET is not configured; refusing to run.");
    return fail("Billing is not configured", 500);
  }
  if (req.headers.get("x-cron-secret") !== cronSecret) {
    return fail("Not authorized", 401);
  }

  let dryRun = false;
  try {
    const body = await req.json();
    dryRun = body?.dryRun === true;
  } catch {
    // No body is fine — a plain scheduled call means "do the real thing".
  }

  const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN");
  const locationId = Deno.env.get("SQUARE_LOCATION_ID");
  if (!squareToken || !locationId) {
    return fail("Square credentials not configured", 500);
  }
  const squareBaseUrl = getSquareBaseUrl();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const today = localToday();

  const results = {
    today,
    dryRun,
    due: 0,
    charged: 0,
    failed: 0,
    skipped: 0,
    reAnchored: 0,
    breakWeeks: 0,
    totalCents: 0,
    details: [] as Array<Record<string, unknown>>,
  };

  try {
    // ── Who is due? ────────────────────────────────────────────────────────
    // The same closure calendar the order page and process-payment use, so
    // break dates are maintained in exactly one place.
    const { data: closedRows, error: closedError } = await supabase
      .from("blocked_dates")
      .select("date");

    if (closedError) {
      // Without the calendar we cannot tell a break from an ordinary week, and
      // guessing would mean charging families over a closure.
      console.error("Could not load blocked_dates:", closedError);
      return fail("Could not load the closure calendar", 500);
    }

    const closedDates = new Set<string>((closedRows ?? []).map((r) => r.date));

    const { data: due, error: dueError } = await supabase
      .from("subscriptions")
      .select(
        "id, user_id, status, discount_pct, next_billing_date, failed_charge_count, square_customer_id, square_card_id, subscription_plans(name, price_cents), subscription_drink_slots(delivery_day)"
      )
      .eq("status", "active")
      .lte("next_billing_date", today)
      .order("next_billing_date", { ascending: true })
      .limit(MAX_CHARGES_PER_RUN);

    if (dueError) {
      console.error("Could not load due subscriptions:", dueError);
      return fail("Could not load due subscriptions", 500);
    }

    results.due = due?.length ?? 0;

    for (const sub of due ?? []) {
      const plan = Array.isArray(sub.subscription_plans)
        ? sub.subscription_plans[0]
        : sub.subscription_plans;

      const scheduledDate: string = sub.next_billing_date;
      let label: Record<string, unknown> = {
        subscriptionId: sub.id,
        billingDate: scheduledDate,
      };

      if (!plan) {
        results.skipped++;
        results.details.push({ ...label, outcome: "skipped", reason: "plan missing" });
        continue;
      }

      if (!sub.square_card_id || !sub.square_customer_id) {
        results.skipped++;
        results.details.push({ ...label, outcome: "skipped", reason: "no card on file" });
        continue;
      }

      // ── School breaks ────────────────────────────────────────────────────
      // Checked before arrears, because a closure is a legitimate explanation
      // for a gap and must not be mistaken for a neglected subscription.
      const deliveryDays: string[] = (sub.subscription_drink_slots ?? [])
        .map((s: Record<string, string>) => s.delivery_day)
        .filter(Boolean);

      const closure = skipClosedWeeks(scheduledDate, deliveryDays, closedDates);
      const billingDate = closure.billingDate;

      if (closure.skippedWeeks > 0) {
        const weekWord = closure.skippedWeeks === 1 ? "week" : "weeks";
        label = { subscriptionId: sub.id, billingDate };

        results.breakWeeks += closure.skippedWeeks;
        results.details.push({
          subscriptionId: sub.id,
          billingDate: scheduledDate,
          outcome: "break",
          weeksSkipped: closure.skippedWeeks,
          resumesOn: billingDate,
        });

        if (!dryRun) {
          await supabase
            .from("subscriptions")
            .update({ next_billing_date: billingDate, renewal_date: billingDate })
            .eq("id", sub.id);

          // Not load-bearing: if event_type has a CHECK constraint that does not
          // know this value, billing still behaves correctly and only the
          // student's visible history loses a line.
          const { error: eventError } = await supabase.from("subscription_events").insert({
            subscription_id: sub.id,
            event_type: "billing_skipped",
            note: `No charge for ${closure.skippedWeeks} ${weekWord} — school closed. Billing resumes ${billingDate}.`,
          });
          if (eventError) {
            console.warn("Could not log billing_skipped event:", eventError.message);
          }
        }

        // Still ahead of us, so nothing is owed in this run.
        if (daysBetween(billingDate, today) < 0) {
          continue;
        }
        // Otherwise the break is behind us and this week is genuinely due.
      }

      // ── Too far overdue to charge honestly ───────────────────────────────
      const overdueDays = daysBetween(billingDate, today);
      if (overdueDays > MAX_ARREARS_DAYS) {
        const nextBillingDate = advanceBillingDate(billingDate, today);
        results.reAnchored++;
        results.details.push({
          ...label,
          outcome: "re-anchored",
          reason: `${overdueDays} days overdue`,
          nextBillingDate,
        });

        if (!dryRun) {
          await supabase
            .from("subscriptions")
            .update({ next_billing_date: nextBillingDate, renewal_date: nextBillingDate })
            .eq("id", sub.id);
          await supabase.from("subscription_events").insert({
            subscription_id: sub.id,
            event_type: "plan_changed",
            note: `Billing resumed after a ${overdueDays}-day gap; no back charge for missed weeks.`,
          });
        }
        continue;
      }

      const amountCents = amountForPlan(plan.price_cents, sub.discount_pct ?? 0);

      if (amountCents <= 0) {
        const nextBillingDate = advanceBillingDate(billingDate, today);
        results.skipped++;
        results.details.push({ ...label, outcome: "skipped", reason: "zero amount", nextBillingDate });
        if (!dryRun) {
          await supabase
            .from("subscriptions")
            .update({ next_billing_date: nextBillingDate, renewal_date: nextBillingDate })
            .eq("id", sub.id);
        }
        continue;
      }

      if (dryRun) {
        results.charged++;
        results.totalCents += amountCents;
        results.details.push({
          ...label,
          outcome: "would charge",
          plan: plan.name,
          amountCents,
          nextBillingDate: advanceBillingDate(billingDate, today),
        });
        continue;
      }

      const idempotencyKey = chargeIdempotencyKey(sub.id, billingDate);

      // ── Claim this billing period ────────────────────────────────────────
      // The unique index on (subscription_id, billing_date) is what makes a
      // double run harmless: the second one loses this insert and moves on.
      const { error: claimError } = await supabase.from("subscription_charges").insert({
        subscription_id: sub.id,
        billing_date: billingDate,
        amount_cents: amountCents,
        status: "pending",
        idempotency_key: idempotencyKey,
      });

      if (claimError) {
        const { data: prior } = await supabase
          .from("subscription_charges")
          .select("status")
          .eq("subscription_id", sub.id)
          .eq("billing_date", billingDate)
          .maybeSingle();

        if (prior?.status === "succeeded") {
          // Already paid; the date just never advanced. Fix that and move on.
          const nextBillingDate = advanceBillingDate(billingDate, today);
          await supabase
            .from("subscriptions")
            .update({ next_billing_date: nextBillingDate, renewal_date: nextBillingDate })
            .eq("id", sub.id);
          results.skipped++;
          results.details.push({ ...label, outcome: "skipped", reason: "already charged", nextBillingDate });
          continue;
        }

        if (prior?.status === "pending") {
          // Another run holds this period, or one died mid-charge. Either way,
          // charging now risks doubling up. Leave it for a human.
          results.skipped++;
          results.details.push({ ...label, outcome: "skipped", reason: "charge already in flight" });
          continue;
        }

        // A previous attempt failed. Retry against the same idempotency key.
        await supabase
          .from("subscription_charges")
          .update({ status: "pending", amount_cents: amountCents, updated_at: new Date().toISOString() })
          .eq("subscription_id", sub.id)
          .eq("billing_date", billingDate);
      }

      // ── Charge the card on file ──────────────────────────────────────────
      let paymentId: string | null = null;
      let errorDetail: string | null = null;
      let reachedSquare = true;

      try {
        const paymentRes = await fetch(`${squareBaseUrl}/v2/payments`, {
          method: "POST",
          headers: {
            "Square-Version": SQUARE_VERSION,
            "Authorization": `Bearer ${squareToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            source_id: sub.square_card_id,
            customer_id: sub.square_customer_id,
            idempotency_key: idempotencyKey,
            amount_money: { amount: amountCents, currency: "USD" },
            location_id: locationId,
            note: `Birdhouse Subscription — ${plan.name} — week of ${billingDate}`,
          }),
        });

        const paymentData = await paymentRes.json();

        if (!paymentRes.ok || paymentData.errors?.length) {
          const err = paymentData.errors?.[0];
          errorDetail = err?.detail ?? "Declined";
          console.error("Subscription charge declined:", {
            subscriptionId: sub.id,
            billingDate,
            category: err?.category,
            code: err?.code,
            detail: err?.detail,
          });
        } else {
          paymentId = paymentData.payment?.id ?? null;
        }
      } catch (netErr) {
        // Never heard back. The charge may have gone through, so the ledger row
        // stays pending and this subscription is left alone until a human looks.
        reachedSquare = false;
        errorDetail = netErr instanceof Error ? netErr.message : "Square unreachable";
        console.error("Square unreachable during charge:", { subscriptionId: sub.id, billingDate, errorDetail });
      }

      if (!reachedSquare) {
        results.skipped++;
        results.details.push({ ...label, outcome: "unconfirmed", reason: errorDetail });
        continue;
      }

      if (paymentId) {
        const nextBillingDate = advanceBillingDate(billingDate, today);

        await supabase
          .from("subscription_charges")
          .update({
            status: "succeeded",
            square_payment_id: paymentId,
            error_detail: null,
            updated_at: new Date().toISOString(),
          })
          .eq("subscription_id", sub.id)
          .eq("billing_date", billingDate);

        await supabase
          .from("subscriptions")
          .update({
            next_billing_date: nextBillingDate,
            renewal_date: nextBillingDate,
            last_charged_at: new Date().toISOString(),
            failed_charge_count: 0,
          })
          .eq("id", sub.id);

        await supabase.from("subscription_events").insert({
          subscription_id: sub.id,
          event_type: "charged",
          amount_cents: amountCents,
          note: `${plan.name} — week of ${billingDate}`,
        });

        results.charged++;
        results.totalCents += amountCents;
        results.details.push({ ...label, outcome: "charged", plan: plan.name, amountCents, nextBillingDate });
        continue;
      }

      // ── Declined ─────────────────────────────────────────────────────────
      // The billing date is deliberately not advanced, so tomorrow's run tries
      // again for the same week rather than skipping it.
      const attempts = (sub.failed_charge_count ?? 0) + 1;
      const giveUp = attempts >= MAX_FAILED_ATTEMPTS;

      await supabase
        .from("subscription_charges")
        .update({ status: "failed", error_detail: errorDetail, updated_at: new Date().toISOString() })
        .eq("subscription_id", sub.id)
        .eq("billing_date", billingDate);

      await supabase
        .from("subscriptions")
        .update({
          failed_charge_count: attempts,
          ...(giveUp ? { status: "payment_failed" } : {}),
        })
        .eq("id", sub.id);

      await supabase.from("subscription_events").insert({
        subscription_id: sub.id,
        event_type: "charge_failed",
        amount_cents: amountCents,
        note: giveUp
          ? `${errorDetail} — paused after ${attempts} attempts`
          : `${errorDetail} — attempt ${attempts} of ${MAX_FAILED_ATTEMPTS}`,
      });

      results.failed++;
      results.details.push({
        ...label,
        outcome: "failed",
        reason: errorDetail,
        attempt: attempts,
        pausedForReview: giveUp,
      });
    }

    console.log("charge-subscriptions run complete:", {
      today,
      dryRun,
      due: results.due,
      charged: results.charged,
      failed: results.failed,
      skipped: results.skipped,
      reAnchored: results.reAnchored,
      breakWeeks: results.breakWeeks,
      totalCents: results.totalCents,
    });

    return ok({ success: true, ...results });
  } catch (err) {
    console.error("charge-subscriptions unexpected error:", err);
    return fail(err instanceof Error ? err.message : "Billing run failed", 500);
  }
});
