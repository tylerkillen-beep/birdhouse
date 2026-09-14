-- Subscription drinks in the Order Queue.
--
-- A subscription is a standing weekly order: each drink slot says "this drink,
-- this weekday, this time, this room". Nothing ever turned those slots into
-- anything the Order Queue reads, which only looks at the orders table, so
-- subscription drinks never showed up for staff to make.
--
-- They are not copied into orders on purpose. Every row there is read as a
-- sale -- the sales report counts its items and its order, and the customer's
-- order history lists it -- and a subscription drink was already paid for by
-- the weekly charge. Instead the queue asks subscription_queue() which drinks
-- are due on which dates, worked out live from the slots, and staff closing
-- one out is recorded in subscription_deliveries.
--
-- A slot is due on a date when:
--   * the subscription is active (paused or payment_failed get nothing),
--   * the date falls on the slot's delivery weekday,
--   * the date is not a closed day in blocked_dates (the same calendar that
--     skips billing, so nobody is charged for a week they get nothing), and
--   * it is not past the season end -- unless the week was already paid for,
--     since a charge taken before the season ended covers its full seven days.
--
-- Undelivered drinks are only worked out for today and later. Past dates show
-- the drinks someone actually closed out; without that floor, a subscriber
-- who resubscribed would appear to be owed every weekday from their cancelled
-- gap.
--
-- Safe to run more than once.

-- ── 1. What staff did with each drink ────────────────────────────────────────
create table if not exists public.subscription_deliveries (
  subscription_id   uuid not null references public.subscriptions (id) on delete cascade,
  slot_number       integer not null,
  delivery_date     date not null,
  status            text not null,
  -- What the slot said when it was closed out, so a later change to the slot
  -- does not rewrite what was made that day.
  drink_name        text,
  drink_modifiers   jsonb,
  delivery_time     text,
  delivery_location text,
  customer_name     text,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (subscription_id, slot_number, delivery_date),
  constraint subscription_deliveries_status_check check (status in ('delivered', 'cancelled'))
);

create index if not exists idx_subscription_deliveries_date
  on public.subscription_deliveries (delivery_date);

-- Nobody writes from the browser; set_subscription_delivery_status() does.
-- The read policy is added below, once the function it uses exists.
alter table public.subscription_deliveries enable row level security;

-- ── 2. Who works the queue ───────────────────────────────────────────────────
-- is_owner_or_staff() is admins and managers only, but student staff run the
-- queue too (see 20260325_add_student_staff_orders_read_policy.sql).
create or replace function public.is_order_queue_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_owner_or_staff()
      or exists (
        select 1
          from public.students s
         where s.id = auth.uid()
           and s.role in ('student', 'manager', 'admin')
      );
$$;

revoke all on function public.is_order_queue_staff() from public;
grant execute on function public.is_order_queue_staff() to anon, authenticated;

drop policy if exists subscription_deliveries_staff_read on public.subscription_deliveries;
create policy subscription_deliveries_staff_read
on public.subscription_deliveries
for select
using (public.is_order_queue_staff());

-- ── 3. Which subscription drinks are due ─────────────────────────────────────
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
         coalesce(sd.customer_name, nullif(p.full_name::text, ''), 'Subscriber'),
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

-- ── 4. Closing one out ───────────────────────────────────────────────────────
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
         nullif(p.full_name, ''),
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

-- ── Check it ────────────────────────────────────────────────────────────────
-- Signed in as staff in the app, the queue calls:
--   select * from public.subscription_queue(current_date, current_date + 7);
-- The SQL editor has no signed-in user, so that call raises there. To see the
-- raw schedule from the editor instead:
--   select s.id, s.status, sds.slot_number, sds.delivery_day, sds.delivery_time, sds.delivery_location from public.subscriptions s join public.subscription_drink_slots sds on sds.subscription_id = s.id where s.status = 'active' order by sds.delivery_day, sds.delivery_time;
