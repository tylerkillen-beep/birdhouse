-- Recurring weekly subscription billing.
--
-- Companion to 20260908_weekly_subscription_billing.sql, which set the cadence.
-- This adds what the charge-subscriptions edge function needs in order to
-- actually bill: a Square card on file per subscription, the bookkeeping to
-- know what is due, and a charge ledger whose unique constraint makes
-- double-charging impossible at the database level instead of relying on
-- application logic being correct.

create extension if not exists pgcrypto;

-- ── Card on file ───────────────────────────────────────────────────────────
-- A one-time Web Payments token can only be charged once, and only right away.
-- save-card exchanges the token from subscribe.html for a Square customer and
-- a stored card; these two ids are what every later charge is made against.
alter table if exists public.subscriptions
  add column if not exists square_customer_id text,
  add column if not exists square_card_id text;

-- ── Billing bookkeeping ────────────────────────────────────────────────────
-- next_billing_date is the single authority for what is due. renewal_date is
-- kept in sync only because older UI read it; new code should not use it.
alter table if exists public.subscriptions
  add column if not exists next_billing_date date,
  add column if not exists renewal_date date,
  add column if not exists last_charged_at timestamptz,
  add column if not exists failed_charge_count integer not null default 0;

alter table if exists public.subscription_events
  add column if not exists amount_cents integer;

do $$
begin
  if to_regclass('public.subscriptions') is not null then
    -- Anything created before this migration only has renewal_date filled in.
    update public.subscriptions
       set next_billing_date = renewal_date
     where next_billing_date is null
       and renewal_date is not null;
  end if;
end $$;

-- The charger's hot query: everything active and due today or earlier.
create index if not exists idx_subscriptions_due
  on public.subscriptions (status, next_billing_date);

-- ── Charge ledger ──────────────────────────────────────────────────────────
create table if not exists public.subscription_charges (
  id               uuid primary key default gen_random_uuid(),
  subscription_id  uuid not null references public.subscriptions (id) on delete cascade,
  billing_date     date not null,
  amount_cents     integer not null,
  status           text not null default 'pending',
  square_payment_id text,
  idempotency_key  text not null,
  error_detail     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint subscription_charges_status_check check (status in ('pending', 'succeeded', 'failed')),
  constraint subscription_charges_amount_nonnegative check (amount_cents >= 0)
);

-- One charge per subscription per billing date. This is the guard that makes a
-- double run of the cron job — or a retry after a network timeout — physically
-- unable to bill a student twice for the same week.
create unique index if not exists subscription_charges_period_key
  on public.subscription_charges (subscription_id, billing_date);

create index if not exists idx_subscription_charges_created
  on public.subscription_charges (created_at desc);

alter table public.subscription_charges enable row level security;

do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'subscription_charges'
  loop
    execute format('drop policy if exists %I on public.subscription_charges', pol.policyname);
  end loop;
end $$;

-- Staff see every charge; a student sees only their own. Nobody writes from the
-- browser — the charger runs as the service role, which bypasses RLS.
create policy subscription_charges_staff_read
on public.subscription_charges
for select
using (public.is_owner_or_staff());

create policy subscription_charges_own_read
on public.subscription_charges
for select
using (
  exists (
    select 1
    from public.subscriptions s
    where s.id = subscription_charges.subscription_id
      and s.user_id = auth.uid()
  )
);
