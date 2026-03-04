-- Create plans table used by Admin Plan Manager and ensure staff can read/manage subscriptions.

create extension if not exists pgcrypto;

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_cents integer not null default 0,
  drinks_per_week integer not null default 1,
  sort_order integer not null default 1,
  description text,
  allowed_modifiers text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_plans_sort_order on public.plans (sort_order);

alter table public.subscriptions
  add column if not exists plan_id uuid;

alter table public.subscriptions
  add column if not exists user_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'subscriptions_plan_id_fkey'
      and conrelid = 'public.subscriptions'::regclass
  ) then
    alter table public.subscriptions
      add constraint subscriptions_plan_id_fkey
      foreign key (plan_id)
      references public.plans (id)
      on update cascade
      on delete set null;
  end if;
end $$;

alter table public.plans enable row level security;

-- Replace plans policies safely.
do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'plans'
  loop
    execute format('drop policy if exists %I on public.plans', pol.policyname);
  end loop;
end $$;

create policy plans_select_policy
on public.plans
for select
using (coalesce(active, false) = true or public.is_owner_or_staff());

create policy plans_staff_write_policy
on public.plans
for all
using (public.is_owner_or_staff())
with check (public.is_owner_or_staff());

-- Keep existing subscriptions_own policy and add staff-wide access policy.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'subscriptions'
      and policyname = 'subscriptions_staff_all_policy'
  ) then
    create policy subscriptions_staff_all_policy
    on public.subscriptions
    for all
    using (public.is_owner_or_staff())
    with check (public.is_owner_or_staff());
  end if;
end $$;
