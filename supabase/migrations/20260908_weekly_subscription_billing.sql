-- Move subscriptions from monthly billing to weekly billing.
--
-- The school calendar runs in weeks, not months, so a subscription that renews
-- on "the 14th" drifts across breaks and half-days. Cadence now lives in the
-- data as billing_interval instead of being implied by the UI copy, so the
-- save-card edge function and the Square subscription plan have one thing to
-- read.
--
-- Prices are deliberately left alone: price_cents keeps whatever value it has
-- and is now read as a per-week amount. Repricing is done by hand in the Admin
-- Plan Manager before this goes live.

alter table if exists public.subscription_plans
  add column if not exists billing_interval text not null default 'week';

alter table if exists public.subscriptions
  add column if not exists billing_interval text not null default 'week';

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'subscription_plans'
      and c.relkind = 'r'
  ) and not exists (
    select 1
    from pg_constraint
    where conname = 'subscription_plans_billing_interval_check'
      and conrelid = 'public.subscription_plans'::regclass
  ) then
    alter table public.subscription_plans
      add constraint subscription_plans_billing_interval_check
      check (billing_interval in ('week', 'month'));
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'subscriptions'
      and c.relkind = 'r'
  ) and not exists (
    select 1
    from pg_constraint
    where conname = 'subscriptions_billing_interval_check'
      and conrelid = 'public.subscriptions'::regclass
  ) then
    alter table public.subscriptions
      add constraint subscriptions_billing_interval_check
      check (billing_interval in ('week', 'month'));
  end if;
end $$;

-- Existing rows predate the column and were all monthly; move them to weekly.
-- Adding the column above already backfills, so this only matters on a database
-- where billing_interval was created ahead of this migration.
do $$
begin
  if to_regclass('public.subscription_plans') is not null then
    update public.subscription_plans
       set billing_interval = 'week'
     where billing_interval is distinct from 'week';
  end if;

  if to_regclass('public.subscriptions') is not null then
    update public.subscriptions
       set billing_interval = 'week'
     where billing_interval is distinct from 'week';
  end if;
end $$;

-- Billing dates already on the books are left untouched on purpose. A student
-- who paid through the 14th keeps the 14th as their next charge; the weekly
-- cadence starts from that date forward. Nobody gets charged early because the
-- cadence changed.
