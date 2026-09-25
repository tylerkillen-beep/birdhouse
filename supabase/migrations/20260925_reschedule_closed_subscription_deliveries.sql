-- Subscription deliveries that fall on a closed day move within their week.
--
-- Until now a drink whose weekday was a closed date (blocked_dates) simply never
-- appeared in the Order Queue, while the subscriber was still charged for the
-- week. Now it is rescheduled inside the same Monday-Friday week, so everyone
-- still gets every drink they pay for:
--
--   1. Wednesday, if it is open (a closed Monday, Tuesday, Thursday or Friday
--      all land there);
--   2. otherwise the nearest open weekday to the original day, the earlier one
--      when two are equally near (a closed Wednesday goes to Tuesday);
--   3. Mathews delivers only Monday/Wednesday/Friday, so its drinks only move to
--      one of those days;
--   4. a week with no open day at all delivers nothing, as before.
--
-- The time and room stay as the subscriber set them. Nothing checks how many
-- drinks are already booked for the new day: the drink is owed, so the kitchen
-- makes room.
--
-- Deliveries are worked out live from the slots and the closure calendar, so
-- closing a day (or reopening it) needs no clean-up of any subscriber's data.
--
-- Run after 20260914_subscriber_display_names.sql. Safe to run more than once.
-- charge-subscriptions must be redeployed with it: a week whose only delivery
-- day was closed is now delivered, so it is now charged.

-- ── 1. The rule, in one place ───────────────────────────────────────────────
-- Where a drink scheduled for p_date is actually delivered: p_date itself when
-- open, else the day it moves to, or null when nothing in that week is open.
create or replace function public.subscription_delivery_date(
  p_date    date,
  p_mathews boolean default false
)
returns date
language sql
stable
set search_path = public
as $$
  select case
    when p_date is null then null
    when not exists (select 1 from blocked_dates b where b.date = p_date) then p_date
    else (
      select c.d
        from (
          select (p_date - (extract(isodow from p_date)::int - 1)) + i as d
            from generate_series(0, 4) as i
        ) c
       where not exists (select 1 from blocked_dates b where b.date = c.d)
         and (not coalesce(p_mathews, false) or extract(isodow from c.d) in (1, 3, 5))
       order by (extract(isodow from c.d) = 3) desc,
                abs(c.d - p_date),
                c.d
       limit 1
    )
  end;
$$;

revoke all on function public.subscription_delivery_date(date, boolean) from public, anon;
grant execute on function public.subscription_delivery_date(date, boolean) to authenticated;

-- ── 2. Which subscription drinks are due (moved ones included) ──────────────
-- One row per drink per delivery date between p_from and p_to. moved_from is the
-- day the drink was originally scheduled for when a closure pushed it to
-- delivery_date, and null otherwise. The return type gains that column, which
-- create or replace cannot do, so the function is dropped first.
drop function if exists public.subscription_queue(date, date);

create function public.subscription_queue(p_from date, p_to date)
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
  status_updated_at timestamptz,
  moved_from        date
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_today      date := (now() at time zone 'America/Chicago')::date;
  v_from       date;
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

  v_from := greatest(p_from, v_today);

  select case when jsonb_typeof(c.value) = 'string'
               and (c.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
              then (c.value #>> '{}')::date end
    into v_season_end
    from store_config c
   where c.key = 'subscription_season_end';

  return query
  with days as (
    -- A drink moves at most four days within its week, so look that far past
    -- the range for originals whose new date lands inside it.
    select (v_from - 4) + i as d
      from generate_series(0, (p_to + 4) - (v_from - 4)) as i
  ),
  originals as (
    select sds.subscription_id,
           sds.slot_number,
           days.d as original_date,
           public.subscription_delivery_date(days.d, p.location = 'mathews') as new_date
      from subscriptions s
      join subscription_drink_slots sds on sds.subscription_id = s.id
      left join profiles p on p.id = s.user_id
      join days on to_char(days.d, 'FMDay') = sds.delivery_day
     where s.status = 'active'
       and (v_season_end is null
            or days.d < v_season_end
            or days.d < s.next_billing_date)
  ),
  scheduled as (
    select o.subscription_id, o.slot_number, o.new_date as delivery_date,
           case when o.original_date <> o.new_date then o.original_date end as moved_from
      from originals o
     where o.new_date between v_from and p_to
  ),
  recorded as (
    select sd.subscription_id, sd.slot_number, sd.delivery_date
      from subscription_deliveries sd
     where sd.delivery_date between p_from and p_to
  ),
  wanted as (
    select * from scheduled
    union all
    select r.subscription_id, r.slot_number, r.delivery_date, null::date
      from recorded r
     where not exists (
       select 1 from scheduled x
        where x.subscription_id = r.subscription_id
          and x.slot_number     = r.slot_number
          and x.delivery_date   = r.delivery_date
     )
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
         sd.updated_at,
         w.moved_from
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

-- ── 3. What is changing for the signed-in subscriber ────────────────────────
-- Their drinks over the next two weeks that a closure has moved (or, when the
-- whole week is closed, cancelled: delivery_date is null), so the dashboard can
-- say so before it happens.
create or replace function public.my_moved_subscription_deliveries()
returns table (
  slot_number    integer,
  drink_name     text,
  scheduled_date date,
  delivery_date  date
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
  if auth.uid() is null then
    return;
  end if;

  select case when jsonb_typeof(c.value) = 'string'
               and (c.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
              then (c.value #>> '{}')::date end
    into v_season_end
    from store_config c
   where c.key = 'subscription_season_end';

  return query
  select x.slot_number, x.drink_name, x.scheduled_date, x.new_date
    from (
      select sds.slot_number::integer as slot_number,
             mi.name::text            as drink_name,
             days.d                   as scheduled_date,
             public.subscription_delivery_date(days.d, p.location = 'mathews') as new_date,
             s.next_billing_date
        from subscriptions s
        join subscription_drink_slots sds on sds.subscription_id = s.id
        left join profiles p on p.id = s.user_id
        left join menu_items mi on mi.id = sds.drink_item_id
        join (select (v_today - 4) + i as d from generate_series(0, 18) as i) days
          on to_char(days.d, 'FMDay') = sds.delivery_day
       where s.user_id = auth.uid()
         and s.status = 'active'
    ) x
   where (v_season_end is null
          or x.scheduled_date < v_season_end
          or x.scheduled_date < x.next_billing_date)
     and ((x.new_date is null and x.scheduled_date >= v_today)
          or (x.new_date >= v_today and x.new_date <> x.scheduled_date))
   order by x.scheduled_date, x.slot_number;
end;
$$;

revoke all on function public.my_moved_subscription_deliveries() from public, anon;
grant execute on function public.my_moved_subscription_deliveries() to authenticated;

-- ── Checking it ─────────────────────────────────────────────────────────────
-- Where a Monday goes when it is closed (block the date first in Admin → Closed
-- Days, or insert into blocked_dates):
--   select public.subscription_delivery_date('2026-09-28', false);   -- a Wednesday
--   select public.subscription_delivery_date('2026-09-28', true);    -- Mathews: Wednesday
-- The queue for the week, with moved drinks flagged:
--   select delivery_date, moved_from, customer_name, drink_name
--     from public.subscription_queue(current_date, current_date + 7)
--    order by delivery_date, delivery_time;
