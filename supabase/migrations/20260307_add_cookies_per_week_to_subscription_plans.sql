-- Add cookies_per_week perk field for admin plan management.

alter table if exists public.subscription_plans
  add column if not exists cookies_per_week integer not null default 0;

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
    where conname = 'subscription_plans_cookies_per_week_nonnegative'
      and conrelid = 'public.subscription_plans'::regclass
  ) then
    alter table public.subscription_plans
      add constraint subscription_plans_cookies_per_week_nonnegative
      check (cookies_per_week >= 0);
  end if;
end $$;
