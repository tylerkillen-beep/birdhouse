-- Subscriber names, resolved the way checkout resolves them.
--
-- A regular order carries the customer's name because customer/order.html
-- builds it from the signed-in account at checkout (resolveCustomerName) and
-- process-payment stores it on the order. A subscription never stores a name,
-- and profiles.full_name is often blank, so the admin Subscriptions tab and the
-- Order Queue fell back to an email address or "Subscriber".
--
-- customer_display_name() applies the same rules as checkout, reading the
-- account from auth.users, which the browser cannot see for other people:
--   1. first_name / given_name, plus last_name / family_name
--   2. otherwise full_name / name, then profiles.full_name
--   3. otherwise the name on their most recent order
-- Anything that looks like an email address is skipped at every step.
--
-- Run after 20260914_subscription_drinks_in_order_queue.sql. It re-creates
-- subscription_queue() and set_subscription_delivery_status() unchanged
-- except for where the name comes from. Safe to run more than once.

-- ── 1. One customer's name ──────────────────────────────────────────────────
create or replace function public.customer_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with acct as (
    select u.raw_user_meta_data as m
      from auth.users u
     where u.id = p_user_id
  ),
  parts as (
    select nullif(trim(coalesce(nullif(trim(m ->> 'first_name'), ''), m ->> 'given_name')), '') as first_name,
           nullif(trim(coalesce(nullif(trim(m ->> 'last_name'), ''), m ->> 'family_name')), '') as last_name,
           nullif(trim(coalesce(nullif(trim(m ->> 'full_name'), ''), m ->> 'name')), '') as full_name
      from acct
  ),
  candidates as (
    select 1 as priority, case when first_name is not null
                           then trim(first_name || ' ' || coalesce(last_name, '')) end as name
      from parts
    union all
    select 2, full_name from parts
    union all
    select 3, nullif(trim(p.full_name), '')
      from profiles p
     where p.id = p_user_id
    union all
    select 4, (select nullif(trim(o.customer_name), '')
                 from orders o
                where o.user_id = p_user_id
                  and nullif(trim(o.customer_name), '') is not null
                  and o.customer_name not like '%@%'
                order by o.created_at desc
                limit 1)
  )
  select name
    from candidates
   where name is not null
     and name not like '%@%'
   order by priority
   limit 1;
$$;

-- It reads auth.users, so only other database functions call it directly.
revoke all on function public.customer_display_name(uuid) from public, anon, authenticated;

-- ── 2. Names for a page of customers (admin Subscriptions tab) ─────────────
create or replace function public.customer_display_names(p_user_ids uuid[])
returns table (user_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_order_queue_staff() then
    raise exception 'Only Birdhouse staff can look up customer names.';
  end if;

  return query
  select ids.id, public.customer_display_name(ids.id)
    from (select distinct unnest(p_user_ids) as id) ids
   where ids.id is not null;
end;
$$;

revoke all on function public.customer_display_names(uuid[]) from public, anon;
grant execute on function public.customer_display_names(uuid[]) to authenticated;

-- ── 3. Which subscription drinks are due (name now resolved) ────────────────
-- One row per drink per date between p_from and p_to. status is 'paid' for a
-- drink still to be made, matching how the queue treats a paid order.
create or replace function public.subscription_queue(p_from date, p_to date)
returns table (
  subscription_id   uuid,
  slot_number       integer,
  delivery_date     date,
  delivery_day      text,
  delivery_time     text,
  delivery_location text,
  drink_name        text,
  drink_modifiers   jsonb,
  customer_name     text,
  customer_location text,
  user_id           uuid,
  plan_name         text,
  status            text,
  status_updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_today      date := (now() at time zone 'America/Chicago')::date;
  v_season_end date;
begin
  if not public.is_order_queue_staff() then
    raise exception 'Only Birdhouse staff can view the subscription queue.';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    return;
  end if;

  -- A year is far more than the queue ever asks for; this only stops a typo
  -- from generating thousands of rows.
  if p_to - p_from > 366 then
    raise exception 'Ask for at most a year of subscription drinks at a time.';
  end if;

  select case when jsonb_typeof(c.value) = 'string'
               and (c.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
              then (c.value #>> '{}')::date end
    into v_season_end
    from store_config c
   where c.key = 'subscription_season_end';

  return query
  with days as (
    select greatest(p_from, v_today) + i as d
      from generate_series(0, p_to - greatest(p_from, v_today)) as i
  ),
  scheduled as (
    select sds.subscription_id, sds.slot_number, days.d as delivery_date
      from subscriptions s
      join subscription_drink_slots sds on sds.subscription_id = s.id
      join days on to_char(days.d, 'FMDay') = sds.delivery_day
     where s.status = 'active'
       and not exists (select 1 from blocked_dates b where b.date = days.d)
       and (v_season_end is null
            or days.d < v_season_end
            or days.d < s.next_billing_date)
  ),
  recorded as (
    select sd.subscription_id, sd.slot_number, sd.delivery_date
      from subscription_deliveries sd
     where sd.delivery_date between p_from and p_to
  ),
  wanted as (
    select * from scheduled
    union
    select * from recorded
  )
  -- The casts matter: RETURN QUERY refuses a varchar or smallint where the
  -- declared result says text or integer, and those older tables' exact
  -- column types are not in version control.
  select w.subscription_id,
         w.slot_number::integer,
         w.delivery_date,
         to_char(w.delivery_date, 'FMDay'),
         coalesce(sd.delivery_time, sds.delivery_time::text),
         coalesce(sd.delivery_location, sds.delivery_location::text),
         coalesce(sd.drink_name, mi.name::text),
         coalesce(sd.drink_modifiers, to_jsonb(sds.drink_modifiers), '[]'::jsonb),
         coalesce(sd.customer_name, public.customer_display_name(s.user_id), 'Subscriber'),
         case when p.location = 'mathews' then 'mathews' end,
         s.user_id,
         sp.name::text,
         coalesce(sd.status, 'paid'),
         sd.updated_at
    from wanted w
    join subscriptions s on s.id = w.subscription_id
    left join subscription_drink_slots sds
           on sds.subscription_id = w.subscription_id
          and sds.slot_number = w.slot_number
    left join subscription_deliveries sd
           on sd.subscription_id = w.subscription_id
          and sd.slot_number = w.slot_number
          and sd.delivery_date = w.delivery_date
    left join menu_items mi on mi.id = sds.drink_item_id
    left join profiles p on p.id = s.user_id
    left join subscription_plans sp on sp.id = s.plan_id;
end;
$$;

revoke all on function public.subscription_queue(date, date) from public, anon;
grant execute on function public.subscription_queue(date, date) to authenticated;

-- ── 4. Closing one out (name now resolved) ─────────────────────────────────
-- p_status 'delivered' or 'cancelled' records it; 'paid' puts it back on the
-- queue.
create or replace function public.set_subscription_delivery_status(
  p_subscription_id uuid,
  p_slot_number     integer,
  p_delivery_date   date,
  p_status          text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_order_queue_staff() then
    raise exception 'Only Birdhouse staff can update subscription drinks.';
  end if;

  if p_status = 'paid' then
    delete from subscription_deliveries
     where subscription_id = p_subscription_id
       and slot_number = p_slot_number
       and delivery_date = p_delivery_date;
    return;
  end if;

  if p_status not in ('delivered', 'cancelled') then
    raise exception 'Unknown status: %', p_status;
  end if;

  insert into subscription_deliveries (
    subscription_id, slot_number, delivery_date, status,
    drink_name, drink_modifiers, delivery_time, delivery_location, customer_name,
    updated_by
  )
  select sds.subscription_id, sds.slot_number, p_delivery_date, p_status,
         mi.name, to_jsonb(sds.drink_modifiers), sds.delivery_time, sds.delivery_location,
         public.customer_display_name(s.user_id),
         auth.uid()
    from subscription_drink_slots sds
    join subscriptions s on s.id = sds.subscription_id
    left join menu_items mi on mi.id = sds.drink_item_id
    left join profiles p on p.id = s.user_id
   where sds.subscription_id = p_subscription_id
     and sds.slot_number = p_slot_number
  on conflict (subscription_id, slot_number, delivery_date) do update
     set status     = excluded.status,
         updated_by = excluded.updated_by,
         updated_at = now();

  if not found then
    raise exception 'That subscription drink no longer exists.';
  end if;
end;
$$;

revoke all on function public.set_subscription_delivery_status(uuid, integer, date, text) from public, anon;
grant execute on function public.set_subscription_delivery_status(uuid, integer, date, text) to authenticated;

