-- Period-based delivery times for the high school, capped per time slot.
--
-- Deliveries land twice per class period: 10 minutes after it starts (rounded
-- up to the next :00/:05) and 10 minutes before it ends (rounded down), so a
-- runner never walks in during the first or last 10 minutes of class. Monday
-- runs a different bell schedule, so it has its own list. There are no
-- deliveries during Monday collaboration, STAR (5th hour), or lunch (6th
-- hour), and the last one is 1:30 PM, the end of 7th hour.
--
-- Each slot takes at most `capacity` people on a given date. An active
-- subscription holds its spot every week on its delivery day; a one-time
-- delivery (coffee or sticker order) holds it for its date. One person is one
-- stop, however many drinks or orders they have in the slot. Pickups are not
-- counted, and Mathews is left on its own fixed times.
--
-- To change the times or the cap later, edit the 'delivery_schedule' row in
-- store_config. The old 'delivery_times' list is left in place because pickups
-- and Mathews still use it.

-- ── 1. The schedule ───────────────────────────────────────────────────────
insert into public.store_config (key, value)
values (
  'delivery_schedule',
  '{
    "capacity": 10,
    "days": {
      "Monday":    ["8:10 AM","8:35 AM","9:05 AM","9:30 AM","10:00 AM","10:25 AM","10:55 AM","11:20 AM","1:05 PM","1:30 PM"],
      "Tuesday":   ["7:40 AM","8:05 AM","8:35 AM","9:00 AM","9:30 AM","9:50 AM","10:20 AM","10:45 AM","1:05 PM","1:30 PM"],
      "Wednesday": ["7:40 AM","8:05 AM","8:35 AM","9:00 AM","9:30 AM","9:50 AM","10:20 AM","10:45 AM","1:05 PM","1:30 PM"],
      "Thursday":  ["7:40 AM","8:05 AM","8:35 AM","9:00 AM","9:30 AM","9:50 AM","10:20 AM","10:45 AM","1:05 PM","1:30 PM"],
      "Friday":    ["7:40 AM","8:05 AM","8:35 AM","9:00 AM","9:30 AM","9:50 AM","10:20 AM","10:45 AM","1:05 PM","1:30 PM"]
    }
  }'::jsonb
)
on conflict (key) do update set value = excluded.value;

-- ── 2. Holds ──────────────────────────────────────────────────────────────
-- process-payment reserves a spot just before it charges the card, and the
-- order row is only written after the charge. The hold covers that gap. It
-- lapses on its own, so a failed charge frees the spot within five minutes.
create table if not exists public.delivery_slot_holds (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  delivery_date date not null,
  delivery_time text not null,
  expires_at    timestamptz not null default now() + interval '5 minutes'
);

-- No policies: only edge functions (service role) and the functions below
-- touch this table.
alter table public.delivery_slot_holds enable row level security;

-- ── 3. Helpers ────────────────────────────────────────────────────────────
create or replace function public.delivery_schedule_times(p_day text)
returns text[]
language sql stable
set search_path = public
as $$
  select coalesce(
    (select array(select jsonb_array_elements_text(value -> 'days' -> p_day))
       from store_config where key = 'delivery_schedule'),
    '{}'::text[]
  );
$$;

create or replace function public.delivery_slot_capacity()
returns int
language sql stable
set search_path = public
as $$
  select coalesce(
    (select (value ->> 'capacity')::int from store_config where key = 'delivery_schedule'),
    10
  );
$$;

-- The next p_weeks dates, starting today at the school, that fall on p_day.
create or replace function public.delivery_upcoming_dates(p_day text, p_weeks int default 3)
returns setof date
language sql stable
set search_path = public
as $$
  select d
    from (select (now() at time zone 'America/Chicago')::date + i as d
            from generate_series(0, 7 * p_weeks - 1) as i) days
   where to_char(d, 'FMDay') = p_day;
$$;

-- Everyone receiving a high school delivery at p_time on p_date. p_skip_sub
-- and p_skip_slot leave out one subscription slot, so a subscriber saving that
-- slot is judged against everyone else.
create or replace function public.delivery_slot_people(
  p_date date, p_time text, p_skip_sub uuid default null, p_skip_slot int default null)
returns setof uuid
language sql stable
set search_path = public
as $$
  select s.user_id
    from subscription_drink_slots sds
    join subscriptions s on s.id = sds.subscription_id
    left join profiles p on p.id = s.user_id
   where s.status = 'active'
     and sds.delivery_day = to_char(p_date, 'FMDay')
     and sds.delivery_time = p_time
     and coalesce(p.location, '') <> 'mathews'
     and (p_skip_sub is null
          or not (sds.subscription_id = p_skip_sub and sds.slot_number = p_skip_slot))
  union
  select o.user_id
    from orders o
   where o.delivery_date = p_date
     and o.delivery_time = p_time
     and o.delivery_method = 'delivery'
     and coalesce(o.status, '') not in ('cancelled', 'refunded')
     and coalesce(o.customer_location, '') <> 'mathews'
  union
  select h.user_id
    from delivery_slot_holds h
   where h.delivery_date = p_date
     and h.delivery_time = p_time
     and h.expires_at > now();
$$;

-- Whether p_user can take the slot: they are already in it (so adding them
-- changes nothing), or it has fewer people than the cap.
create or replace function public.delivery_slot_has_room(
  p_date date, p_time text, p_user uuid, p_skip_sub uuid default null, p_skip_slot int default null)
returns boolean
language sql stable
set search_path = public
as $$
  with people as (
    select u from delivery_slot_people(p_date, p_time, p_skip_sub, p_skip_slot) as u
  )
  select exists (select 1 from people where u = p_user)
      or (select count(*) from people) < delivery_slot_capacity();
$$;

-- These read other customers' orders and subscriptions; only the functions
-- below may call them.
revoke all on function public.delivery_slot_people(date, text, uuid, int) from public, anon, authenticated;
revoke all on function public.delivery_slot_has_room(date, text, uuid, uuid, int) from public, anon, authenticated;

-- ── 4. What the pages ask ─────────────────────────────────────────────────
-- Each delivery time on one date and whether it still has room for the
-- signed-in customer. Used by the order and sticker pages.
create or replace function public.delivery_slots_for_date(p_date date)
returns table (slot_time text, has_room boolean)
language sql stable security definer
set search_path = public
as $$
  select t, delivery_slot_has_room(p_date, t, auth.uid())
    from unnest(delivery_schedule_times(to_char(p_date, 'FMDay'))) with ordinality as x(t, n)
   order by n;
$$;

-- The same for a weekly subscription. A time only has room if it has room on
-- each of the next three times that weekday comes around, which covers every
-- one-time order that can already be booked.
create or replace function public.delivery_slots_for_weekday(p_day text)
returns table (slot_time text, has_room boolean)
language sql stable security definer
set search_path = public
as $$
  select t, bool_and(delivery_slot_has_room(d, t, auth.uid()))
    from unnest(delivery_schedule_times(p_day)) with ordinality as x(t, n)
   cross join delivery_upcoming_dates(p_day) as d
   group by t, n
   order by n;
$$;

grant execute on function public.delivery_slots_for_date(date) to anon, authenticated;
grant execute on function public.delivery_slots_for_weekday(text) to anon, authenticated;

-- ── 5. Claiming a one-time delivery ───────────────────────────────────────
-- Called by process-payment just before it charges the card. Returns false
-- when the slot is full, and raises when the time is not a delivery time that
-- day or has already passed; those messages are shown to the customer.
--
-- The advisory lock is shared with the subscription trigger below, so
-- everyone booking the same weekday and time waits their turn and two people
-- cannot both take the last spot.
create or replace function public.claim_delivery_slot(p_date date, p_time text, p_user uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_day text := to_char(p_date, 'FMDay');
begin
  if not (p_time = any(delivery_schedule_times(v_day))) then
    raise exception '% is not a delivery time on %. Please pick another time.', p_time, v_day;
  end if;

  if p_date + p_time::time <= (now() at time zone 'America/Chicago') then
    raise exception 'That delivery time has already passed. Please pick another time.';
  end if;

  perform pg_advisory_xact_lock(hashtext('delivery-slot|' || v_day || '|' || p_time));

  delete from delivery_slot_holds where expires_at <= now();

  if not delivery_slot_has_room(p_date, p_time, p_user) then
    return false;
  end if;

  insert into delivery_slot_holds (user_id, delivery_date, delivery_time)
  values (p_user, p_date, p_time);

  return true;
end;
$$;

revoke all on function public.claim_delivery_slot(date, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_delivery_slot(date, text, uuid) to service_role;

-- ── 6. Move existing subscribers onto the new times ───────────────────────
-- Anyone on a time that no longer exists moves to the closest time that day,
-- taking the earlier one on a tie. This runs before the trigger below exists,
-- so nobody is turned away for capacity.
with schedule as (
  select d.key as day, t.value as slot_time
    from store_config c,
         jsonb_each(c.value -> 'days') as d,
         jsonb_array_elements_text(d.value) as t
   where c.key = 'delivery_schedule'
),
moves as (
  select sds.subscription_id, sds.slot_number,
         (select sc.slot_time
            from schedule sc
           where sc.day = sds.delivery_day
           order by abs(extract(epoch from sc.slot_time::time - sds.delivery_time::time)),
                    sc.slot_time::time
           limit 1) as new_time
    from subscription_drink_slots sds
    join subscriptions s on s.id = sds.subscription_id
    left join profiles p on p.id = s.user_id
   where coalesce(p.location, '') <> 'mathews'
     and sds.delivery_time ~ '^\d{1,2}:\d{2} (AM|PM)$'
     and not exists (
       select 1 from schedule sc
        where sc.day = sds.delivery_day and sc.slot_time = sds.delivery_time
     )
)
update subscription_drink_slots sds
   set delivery_time = m.new_time
  from moves m
 where sds.subscription_id = m.subscription_id
   and sds.slot_number = m.slot_number
   and m.new_time is not null;

-- ── 7. Guard subscription slots ───────────────────────────────────────────
-- save-card writes a subscriber's slots before it charges the first week, so
-- raising here rolls the signup back with nothing charged. The check runs on
-- every save, not just changes, so a returning subscriber cannot slip back
-- into a slot that filled while they were away.
create or replace function public.enforce_subscription_delivery_slot()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_user     uuid;
  v_location text;
  v_date     date;
begin
  if new.delivery_day is null or new.delivery_time is null then
    return new;
  end if;

  select s.user_id, p.location
    into v_user, v_location
    from subscriptions s
    left join profiles p on p.id = s.user_id
   where s.id = new.subscription_id;

  if v_location = 'mathews' then
    return new;
  end if;

  if not (new.delivery_time = any(delivery_schedule_times(new.delivery_day))) then
    raise exception '% is not a delivery time on %. Please pick another time.',
      new.delivery_time, new.delivery_day;
  end if;

  perform pg_advisory_xact_lock(hashtext('delivery-slot|' || new.delivery_day || '|' || new.delivery_time));

  for v_date in select delivery_upcoming_dates(new.delivery_day) loop
    if not delivery_slot_has_room(v_date, new.delivery_time, v_user, new.subscription_id, new.slot_number) then
      raise exception 'The % % delivery time is full. Please pick another time.',
        new.delivery_day, new.delivery_time;
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists subscription_delivery_slot_capacity on public.subscription_drink_slots;
create trigger subscription_delivery_slot_capacity
  before insert or update of delivery_day, delivery_time, subscription_id
  on public.subscription_drink_slots
  for each row execute function public.enforce_subscription_delivery_slot();
