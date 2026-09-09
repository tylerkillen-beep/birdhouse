# Weekly Subscription Billing — Setup and Runbook

Subscriptions bill **weekly**. This document covers how it works, how to turn it
on, and what to do when a charge fails.

Nothing here is live until you complete "Turning it on" below. Deploying the
code alone does not charge anyone — the scheduler has to be created too.

---

## How it works

There are two edge functions and one rule: **a one-time card token can only be
charged once, so it is exchanged at signup for a card on file.**

### 1. `save-card` — runs once, when a student subscribes

`customer/subscribe.html` collects the card with the Square Web Payments SDK and
posts the resulting token here. The token expires in minutes and cannot be
reused next week, so this function:

1. Creates a Square **customer** (`POST /v2/customers`).
2. Creates a **card on file** for that customer (`POST /v2/cards`), which
   returns a permanent card id.
3. Stores both ids on the `subscriptions` row.
4. Charges the first week immediately (`POST /v2/payments`), which proves the
   card works before the student is enrolled.
5. Sets `next_billing_date` to seven days out.

If the card is declined, the whole signup is rolled back and the student sees
the decline reason — no half-built subscription is left behind.

### 2. `charge-subscriptions` — runs every day

Loads every subscription that is `status = 'active'` with
`next_billing_date <= today`, charges the stored card, and moves the date
forward seven days.

It runs **daily, not weekly**, on purpose. Each student is still billed every
seventh day, because the date is what decides — but a day the scheduler misses
gets picked up the next morning instead of silently skipping someone's week.

---

## School breaks

**Nobody is charged for a week in which they receive nothing.**

Break dates live in `blocked_dates` — the same closure calendar the order page
and `process-payment` already use, so they are maintained in exactly one place.
Block a break once in **Admin → Closed Days** (click a start and an end date to
block the whole range at once) and delivery and billing both respect it.

The rule is per subscriber, not per school week. When a charge comes due, the
charger works out which dates that subscriber's delivery days land on during the
week ahead. If **every** one of them is closed, it skips the charge and moves
the billing date forward seven days, repeating until it finds a week where they
would actually receive something.

Worked examples, for a Tuesday-billed subscriber during a Thanksgiving week with
Wednesday–Friday closed:

| Their delivery day | Falls on | Outcome |
|---|---|---|
| Wednesday | Nov 25 — closed | **Not charged.** Billing moves to Tue Dec 1 |
| Monday | Nov 30 — open | **Charged.** They still get their drink |

A two-week break is skipped entirely in one run, and because each step is exactly
seven days the subscriber keeps their original weekday forever.

Charging is the default. A subscriber with no drink slots, or a delivery day the
charger cannot parse, is charged normally — skipping a payment requires positive
evidence that the person receives nothing, never merely an absence of evidence
that they receive something.

A skipped week is recorded as a `billing_skipped` event and shows on the
student's dashboard as "No charge — school closed". A run reports its total as
`breakWeeks`, and a dry run shows the skips without writing anything, so you can
confirm a break is set up correctly before it arrives.

The `billing_skipped` value is permitted by
`20260909_allow_billing_skipped_event.sql`, which widens the CHECK constraint on
`subscription_events.event_type`. Without that migration the skip still happens
correctly and only the history line is lost.

---

## Why it will not double-charge

This is the part worth understanding before you turn it on. Three independent
guards, any one of which is enough:

1. **A unique index on `(subscription_id, billing_date)`** in
   `subscription_charges`. A second run for the same week loses the insert and
   moves on. This is enforced by Postgres, not by application logic.
2. **A deterministic Square idempotency key** derived from the subscription id
   and billing date. If a run charges the card and then times out before
   recording it, the retry sends the identical key and Square returns the
   original payment rather than taking the money again.
3. **The date only advances after a confirmed success.** A decline leaves
   `next_billing_date` alone so tomorrow retries the same week, rather than
   skipping it.

Some deliberate choices in the same spirit:

- **Ambiguous failures are never rolled back.** If Square cannot be reached, we
  do not know whether the money moved, so the ledger row stays `pending` and the
  subscription is left for a human. Rolling back there could hide a real charge.
- **More than 14 days overdue means no charge.** A subscription left active over
  spring break should not surprise a student with a charge for a week they never
  drank. It is re-anchored to the next upcoming date and an event is logged.
  Tune with `MAX_ARREARS_DAYS`.
- **Three consecutive declines pauses the subscription** (`payment_failed`)
  instead of retrying a dead card forever. Tune with `MAX_FAILED_ATTEMPTS`.
- **At most 200 charges per run**, so a bad query cannot become a bad afternoon.
  Tune with `MAX_CHARGES_PER_RUN`.

---

## Turning it on

### Step 1 — Set the real weekly prices

`price_cents` still holds last year's **monthly** numbers, and it is now read as
a weekly amount. Shipping as-is would be roughly a 4.3x price increase.

Go to **Admin → Plans** and set each plan's real weekly price before anything
else. The form now reads "Price per Week ($)".

### Step 2 — Run the migrations

```
supabase/migrations/20260908_weekly_subscription_billing.sql
supabase/migrations/20260908_subscription_billing_engine.sql
```

Apply them in that order (Supabase Dashboard → SQL Editor, or `supabase db push`).

### Step 3 — Confirm the column names match your database

The `subscriptions`, `subscription_drink_slots`, and `subscription_events`
tables were created before this repo kept migrations, so their definitions are
not in version control. The code assumes these column names:

| Table | Columns it writes |
|---|---|
| `subscriptions` | `user_id`, `plan_id`, `status`, `discount_pct`, `billing_interval`, `square_customer_id`, `square_card_id`, `next_billing_date`, `renewal_date`, `last_charged_at`, `failed_charge_count` |
| `subscription_drink_slots` | `subscription_id`, `slot_number`, `drink_item_id`, `drink_modifiers`, `delivery_day`, `delivery_time`, `delivery_location` |
| `subscription_events` | `subscription_id`, `event_type`, `amount_cents`, `note` |

Check with:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('subscriptions','subscription_drink_slots','subscription_events')
order by table_name, ordinal_position;
```

Verified against the live database on 2026-09-08. Note that the drink column is
`drink_item_id`, not `menu_item_id` — the customer dashboard reads it through a
`menu_items(name)` join, which hides the real column name, so it is easy to
guess wrong. If these ever drift, `save-card` is what needs updating.

### Step 4 — Set the secrets

`SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, and `SQUARE_ENV` already exist for
`process-payment`. Add one more:

```bash
supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"
```

Keep that value — the scheduler needs it. Without it `charge-subscriptions`
refuses to run at all.

### Step 5 — Deploy the functions

```bash
supabase functions deploy save-card
supabase functions deploy charge-subscriptions --no-verify-jwt
```

Or paste each `index.ts` into Supabase Dashboard → Edge Functions → Deploy.

`charge-subscriptions` must have **JWT verification off**. Supabase's gateway
normally rejects a request without a signed-in user's token, and `pg_cron` has
no user to be — with verification on, every scheduled run fails with a 401
before your code is even reached. `CRON_SECRET` is the gate instead, checked on
the first line of the function. Both settings are recorded in
`supabase/config.toml`, so a CLI deploy picks them up automatically; if you
deploy from the dashboard, set the toggle by hand.

> If a `save-card` function already exists in your project, deploying replaces
> it. Read the deployed version first if you are not certain it was only ever a
> stub.

### Step 6 — Dry run before any money moves

```bash
curl -X POST "https://<project>.supabase.co/functions/v1/charge-subscriptions" \
  -H "x-cron-secret: <CRON_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

This reports exactly who would be charged and how much, and touches nothing.
**Check the amounts against Step 1 before continuing.** Dry run again any time
you change prices.

### Step 7 — Test one real subscription end to end

Point `SQUARE_ENV` at `sandbox`, subscribe as a test student, confirm the first
charge appears in the Square sandbox dashboard and in `subscription_charges`,
then set `next_billing_date` back a week by hand and run the function for real
to watch the recurring charge work.

### Step 8 — Schedule it

In the Supabase Dashboard, enable the `pg_cron` and `pg_net` extensions
(**Database → Extensions**), then run:

```sql
select cron.schedule(
  'charge-subscriptions-daily',
  '0 13 * * *',                       -- 13:00 UTC = 8am Central (7am during DST)
  $$
  select net.http_post(
    url     := 'https://<project>.supabase.co/functions/v1/charge-subscriptions',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
```

Confirm with `select * from cron.job;`. To stop billing entirely:
`select cron.unschedule('charge-subscriptions-daily');`

---

## Runbook

**See what happened on any given day**

```sql
select c.billing_date, c.status, c.amount_cents, c.error_detail,
       p.name as plan, s.user_id
from public.subscription_charges c
join public.subscriptions s on s.id = c.subscription_id
left join public.subscription_plans p on p.id = s.plan_id
order by c.created_at desc
limit 50;
```

**Find anything needing a human.** `pending` rows older than a few minutes mean
a run died mid-charge — check Square for a payment with that `idempotency_key`
before doing anything, since the money may have moved.

```sql
select * from public.subscription_charges
where status = 'pending' and created_at < now() - interval '15 minutes';
```

**Students whose card is failing**

```sql
select id, user_id, failed_charge_count, next_billing_date
from public.subscriptions
where status = 'payment_failed';
```

They see a "Payment Failed" badge and an "Update Card" link on their dashboard.
Once they resubscribe with a good card, set `status = 'active'` and
`failed_charge_count = 0`.

**Stop billing one person right now**

```sql
update public.subscriptions set status = 'paused' where id = '<subscription-id>';
```

**Stop billing everyone right now**

```sql
select cron.unschedule('charge-subscriptions-daily');
```

---

## End of the school year — cancel everything in May

**Subscriptions do not carry over the summer.** Cancel them all when the shop
closes in May; students set them up fresh in the fall.

This is deliberate. Summer is not on the closure calendar, so an active
subscription would bill every week from May to August for drinks nobody
delivers. It is also the honest default for a school: seniors graduate, cards
expire, room numbers change, and a year-old card quietly reactivating in
September is not something a family agreed to.

Run this on the last day of school. It cancels every live subscription and
records why, in one transaction:

```sql
with stopped as (
  update public.subscriptions
     set status = 'cancelled'
   where status in ('active', 'paused', 'payment_failed')
  returning id
)
insert into public.subscription_events (subscription_id, event_type, note)
select id, 'cancelled', 'End of school year — cancelled for summer'
from stopped;
```

Confirm nothing is left running:

```sql
select status, count(*) from public.subscriptions group by status;
```

Nothing should be `active`, `paused`, or `payment_failed`. As a belt-and-braces
check, a dry run should report `"due": 0` every day thereafter.

The subscription rows themselves stay — `subscriptions.user_id` is unique, so a
returning student's signup reuses their existing row and its billing history
rather than starting a second one. Their old card stays on file at Square and is
harmless; `save-card` stores a fresh one when they re-enroll.

If you would rather not rely on remembering, the alternative is to block the
summer weekdays in **Admin → Closed Days** as a single range. Billing then stops
on its own — but `MAX_SKIPPED_WEEKS` in `charge-subscriptions` must be raised
from 10 to about 20 first, because roughly thirteen weeks of summer exceeds the
current cap.

---

## Known gaps

- **Nobody is emailed when a card fails.** The student only finds out by opening
  their dashboard. Square sends its own receipt for successful charges.
- **The unused `plans` table** from
  `20260306_create_plans_table_and_staff_subscriptions_policy.sql` is still
  there; all real code uses `subscription_plans`. Worth dropping separately.
- **No proration on a plan change.** Changing plans mid-week bills the new price
  at the next weekly date, with no adjustment for the days already paid.
