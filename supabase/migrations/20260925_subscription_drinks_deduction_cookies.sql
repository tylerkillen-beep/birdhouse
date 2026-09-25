-- Subscription plans' weekly cookies: on the delivery card, and off the shelf.
--
-- A plan promises some cookies a week (subscription_plans.cookies_per_week) but
-- nothing said which delivery carries them or recorded them going out. Now:
--
--   * Each delivery says how many cookies to include, on its Order Queue card.
--   * Marking the drink delivered records those cookies as used (and, when the
--     Subscription drinks switch is on, takes them off the count). Putting the
--     drink back or cancelling it returns them, exactly like the drink itself.
--
-- Which delivery carries a cookie: the week's cookies are shared out across the
-- subscription's drink slots. With 5 drinks and 2 cookies a week, slots 1 and 2
-- each carry one; with 3 drinks and 5 cookies, slots 1 and 2 carry two each and
-- slot 3 carries one. It goes by slot, not by date, so a delivery moved by a closure
-- keeps its cookie.
--
-- What one cookie uses comes from a menu item you pick in Admin > Usage Setup
-- ("Cookie included with subscription plans"), so its inventory links are the
-- ones already set up for that cookie. The Order Queue shows the cookie whether
-- or not one is picked; the count only moves once it is.
--
-- The count is snapshotted on the delivery when it is closed out, so a later
-- plan change doesn't rewrite what went out that day.
--
-- Run after 20260925_subscription_drinks_deduction.sql. It redefines
-- subscription_queue() and set_subscription_delivery_status() as of the closed-day
-- rescheduling and the deduction migrations. Safe to run more than once.

-- ── Settings and snapshot ────────────────────────────────────────────────────
alter table public.inventory_settings
  add column if not exists subscription_cookie_item_id uuid references public.menu_items(id) on delete set null;

alter table public.subscription_deliveries
  add column if not exists cookies integer not null default 0;

-- ── Cookies on one slot's delivery ───────────────────────────────────────────
create or replace function public.subscription_slot_cookies(p_subscription_id uuid, p_slot_number integer)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with plan as (
    select greatest(coalesce(sp.cookies_per_week, 0), 0) as c
      from public.subscriptions s
      join public.subscription_plans sp on sp.id = s.plan_id
     where s.id = p_subscription_id
  ),
  slots as (
    select sds.slot_number,
           row_number() over (order by sds.slot_number) as rank,
           count(*) over ()                              as n
      from public.subscription_drink_slots sds
     where sds.subscription_id = p_subscription_id
  )
  select coalesce((
    select (plan.c / slots.n) + case when slots.rank <= (plan.c % slots.n) then 1 else 0 end
      from slots cross join plan
     where slots.slot_number = p_slot_number
  ), 0)::integer;
$$;

revoke all on function public.subscription_slot_cookies(uuid, integer) from public, anon;
grant execute on function public.subscription_slot_cookies(uuid, integer) to authenticated;

-- ── The queue, with cookies ──────────────────────────────────────────────────
-- subscription_queue() as of 20260925_reschedule_closed_subscription_deliveries.sql,
-- plus a last column, cookies. The return type changes, so it is dropped first.
-- A drink already closed out reports what was snapshotted; one still to make
-- reports what its plan says now.
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
  moved_from        date,
  cookies           integer
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
         w.moved_from,
         case when sd.subscription_id is not null then sd.cookies
              else public.subscription_slot_cookies(w.subscription_id, w.slot_number::integer) end
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

-- ── Closing one out, snapshotting the cookies ────────────────────────────────
-- set_subscription_delivery_status() as of 20260925_subscription_drinks_deduction.sql,
-- plus the cookies column in the snapshot.
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
    begin
      perform public.release_subscription_delivery_usage(p_subscription_id, p_slot_number, p_delivery_date);
    exception when others then
      raise warning 'set_subscription_delivery_status: stock not put back for %/%/%: %',
        p_subscription_id, p_slot_number, p_delivery_date, sqlerrm;
    end;
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
    cookies, updated_by
  )
  select sds.subscription_id, sds.slot_number, p_delivery_date, p_status,
         mi.name, to_jsonb(sds.drink_modifiers), sds.delivery_time, sds.delivery_location,
         public.customer_display_name(s.user_id),
         public.subscription_slot_cookies(sds.subscription_id, sds.slot_number::integer),
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

-- ── Recording a delivered drink, cookies included ────────────────────────────
-- record_subscription_delivery_usage() as of 20260925_subscription_drinks_deduction.sql,
-- now adding the delivery's cookies (each one uses what the chosen cookie menu
-- item uses) to what the drink used. A delivery whose drink matched no menu item
-- still records its cookies.
create or replace function public.record_subscription_delivery_usage(
  p_subscription_id uuid, p_slot_number integer, p_delivery_date date, p_apply boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.subscription_deliveries%rowtype;
  v_item   uuid;
  v_cookie uuid;
  v_mods   text[];
  v_take   numeric;
  v_at     timestamptz;
  n        integer := 0;
  r        record;
begin
  if exists (select 1 from public.subscription_delivery_usage
              where subscription_id = p_subscription_id and slot_number = p_slot_number
                and delivery_date = p_delivery_date) then
    return 0;
  end if;

  select * into v_row from public.subscription_deliveries
  where subscription_id = p_subscription_id and slot_number = p_slot_number
    and delivery_date = p_delivery_date and status = 'delivered';
  if not found then
    return 0;
  end if;

  v_item := public.subscription_delivery_menu_item(p_subscription_id, p_slot_number, v_row.drink_name);
  select subscription_cookie_item_id into v_cookie from public.inventory_settings where id;
  if coalesce(v_row.cookies, 0) <= 0 then
    v_cookie := null;
  end if;

  if v_item is null and v_cookie is null then
    return 0;
  end if;

  v_mods := coalesce(
    array(
      select x->>'catalogObjectId'
      from jsonb_array_elements(
             case when jsonb_typeof(v_row.drink_modifiers) = 'array' then v_row.drink_modifiers else '[]'::jsonb end
           ) x
      where jsonb_typeof(x) = 'object' and nullif(x->>'catalogObjectId', '') is not null
    ),
    '{}'::text[]
  );

  -- Midday Central on the day it was delivered, like Item Lookup shows it.
  v_at := (p_delivery_date::timestamp + interval '12 hours') at time zone 'America/Chicago';

  for r in
    select t.inventory_id, sum(t.base_amount) as base_amount
    from (
      select u.inventory_id, u.amount as base_amount
        from public.menu_item_usage(v_item, v_mods) u
       where v_item is not null
      union all
      select c.inventory_id, c.amount * v_row.cookies
        from public.menu_item_usage(v_cookie, '{}'::text[]) c
       where v_cookie is not null
    ) t
    group by t.inventory_id
  loop
    v_take := case when p_apply then public.take_from_inventory(r.inventory_id, r.base_amount) else 0 end;
    insert into public.subscription_delivery_usage
      (subscription_id, slot_number, delivery_date, inventory_id, base_amount, applied_amount, applied, sold_at)
    values (p_subscription_id, p_slot_number, p_delivery_date, r.inventory_id, r.base_amount, v_take, p_apply, v_at);
    n := n + 1;
  end loop;

  return n;
end;
$$;

revoke all on function public.record_subscription_delivery_usage(uuid, integer, date, boolean) from public, anon, authenticated;
grant execute on function public.record_subscription_delivery_usage(uuid, integer, date, boolean) to service_role;

-- Check it:
--   -- Cookies per delivery for every active subscription, from its plan:
--   select s.id, sp.name as plan, sp.cookies_per_week, sds.slot_number,
--          public.subscription_slot_cookies(s.id, sds.slot_number::integer) as cookies
--   from public.subscriptions s
--   join public.subscription_plans sp on sp.id = s.plan_id
--   join public.subscription_drink_slots sds on sds.subscription_id = s.id
--   where s.status = 'active' and sp.cookies_per_week > 0
--   order by s.id, sds.slot_number;
