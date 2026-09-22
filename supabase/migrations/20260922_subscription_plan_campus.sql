-- Campus-scoped subscription plans.
--
-- Mathews is already its own customer type everywhere else on the site: its
-- own menu (Square's Teacher Menu category), M/W/F delivery, its own two
-- delivery times, its own room list, and no 25% teacher discount because the
-- Mathews prices in Square are already net. Subscriptions were the one place
-- with no campus concept -- a Mathews teacher who opened subscribe.html saw
-- the high school's plans.
--
-- A plan now belongs to exactly one campus, and a customer is only ever shown
-- the plans for theirs. The column defaults to 'birdhouse', so every plan that
-- exists today keeps behaving exactly as it does now and nothing has to be
-- backfilled by hand.
--
-- The subscription itself does not store a campus. It is whatever its plan
-- says, which cannot drift; profiles.location stays the source of truth for
-- who the subscriber is.
--
-- Safe to run more than once.

alter table public.subscription_plans
  add column if not exists campus text not null default 'birdhouse';

-- 'birdhouse' covers the high school -- students and NHS teachers alike, who
-- share one menu and one set of plans and differ only by the discount applied
-- at checkout. Mathews is the split that matters.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'subscription_plans_campus_check'
      and conrelid = 'public.subscription_plans'::regclass
  ) then
    alter table public.subscription_plans
      add constraint subscription_plans_campus_check
      check (campus in ('birdhouse', 'mathews'));
  end if;
end $$;

-- The subscribe page filters on this on every load, and the Plan Manager
-- groups by it.
create index if not exists idx_subscription_plans_campus
  on public.subscription_plans (campus);

-- ── Verify ─────────────────────────────────────────────────────────────────
--   select campus, count(*), count(*) filter (where active) as active
--   from public.subscription_plans
--   group by campus;
--
-- Before any Mathews plan is created this should report one row:
-- birdhouse, with all of your existing plans.
