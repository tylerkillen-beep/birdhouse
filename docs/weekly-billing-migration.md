# Weekly Subscription Billing — What's Done and What's Left

Subscriptions moved from monthly to weekly billing so the cadence lines up with
the school calendar. This repo holds the schema, the admin views, and the
customer-facing copy. It does **not** hold the code that actually charges the
card, so the switch is only half-done until the items under "Still To Do" are
applied.

## Done in this repo

- `supabase/migrations/20260908_weekly_subscription_billing.sql`
  - Adds `billing_interval` (`'week' | 'month'`, default `'week'`) to
    `subscription_plans` and `subscriptions`.
  - Backfills every existing row to `'week'`.
  - Leaves `price_cents` untouched and leaves existing billing dates untouched.
- `admin/index.html` — plan form asks for "Price per Week", plan cards read
  `$X / week`, and the subscriptions stat card is "Weekly Revenue" (the sum of
  active plan prices, which is now a weekly figure) instead of "MRR".
- `customer/subscribe.html` — plan cards, the billed line, the card-save notice
  ("the same day each week"), and the submit button all read weekly.
- `customer/dashboard.html` — plan price reads `$X/week`, and the next billing
  date now includes the weekday, since a weekly charge lands on the same weekday
  every time.

## Still to do — outside this repo

### 1. The `save-card` edge function

`customer/subscribe.html` posts to `${SUPABASE_URL}/functions/v1/save-card`,
which saves the Square card, creates the `subscriptions` row, and sets the first
billing date. Its source is not in this repository. It needs:

- **Cadence** — whatever creates the Square subscription (or the recurring
  charge schedule) must use a weekly interval instead of monthly.
- **First billing date** — set the initial `renewal_date` / `next_billing_date`
  to one week out rather than one month out.
- **Advance step** — wherever the next date is computed after a successful
  charge, add 7 days instead of 1 month. This also removes the end-of-month edge
  case (a subscription started on the 31st).
- **`billing_interval`** — write `'week'` onto the new `subscriptions` row, or
  let the column default handle it.

### 2. Square

If the recurring charge is driven by a Square subscription plan rather than by
our own scheduler, the plan's cadence has to be changed in Square as well —
changing our database alone will not stop Square from billing monthly.

### 3. Repricing

Plan prices were **not** converted. `price_cents` still holds the old monthly
amount and is now displayed and charged as a weekly amount, which would be
roughly a 4.3x increase if it goes live unchanged. Set the real weekly prices in
**Admin → Plan Manager** before this ships.

### 4. Existing subscribers

The migration deliberately does not touch billing dates already on the books, so
nobody is charged early because the cadence changed. A student paid through the
14th keeps the 14th, and the weekly cadence runs from there — but only once
`save-card` (or whatever advances the date) is doing the 7-day step. Until then,
existing subscriptions keep renewing monthly.

## Note on the unused `plans` table

`20260306_create_plans_table_and_staff_subscriptions_policy.sql` creates a
`public.plans` table, but all application code reads `subscription_plans`. The
weekly migration only touches `subscription_plans` and `subscriptions`. If
`plans` is genuinely dead, it is worth dropping in a separate cleanup.
