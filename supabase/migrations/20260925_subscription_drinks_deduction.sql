-- Inventory usage, phase 3b: subscription drinks take stock off the shelf.
--
-- Run after 20260925_register_sales_deduction.sql (it uses take_from_inventory()
-- and the inventory_usage_history view from there).
--
-- Subscription drinks are not orders: the weekly charge already paid for them,
-- and staff closing one out in the Order Queue is recorded in
-- subscription_deliveries (status 'delivered' or 'cancelled'). That is the moment
-- stock is used, so it is the moment this records it.
--
--   delivered  -> work out what the drink used and record it (once)
--   cancelled  -> put back what was taken, if it had been delivered before
--   put back on the queue ('paid') -> put back what was taken
--
-- What a drink uses is menu_item_usage() for the drink the slot held when it was
-- closed out (the name is snapshotted on the delivery), plus the add-ons in the
-- slot's modifiers -- the same rules as every other channel. One delivery is one
-- drink.
--
-- Deduction has its own switch, inventory_settings.deduct_subscriptions, OFF until
-- you flip it in Admin > Usage Setup. Drinks closed out before that are recorded
-- for history only. As elsewhere, nothing here can stop a delivery from being
-- closed out: a failure is a warning, not an error.
--
-- Not covered: the cookies some plans include each week. Nothing records them
-- being handed out, so they are not deducted.
-- Safe to run more than once.

-- ── The switch ───────────────────────────────────────────────────────────────
alter table public.inventory_settings
  add column if not exists deduct_subscriptions     boolean not null default false,
  add column if not exists subscriptions_enabled_at timestamptz;

-- ── What each delivered drink used ───────────────────────────────────────────
create table if not exists public.subscription_delivery_usage (
  subscription_id uuid        not null,
  slot_number     integer     not null,
  delivery_date   date        not null,
  inventory_id    uuid        not null references public.inventory(id) on delete cascade,
  base_amount     numeric     not null,               -- in inventory.base_unit
  applied_amount  numeric     not null default 0,     -- counted units taken off inventory.quantity
  applied         boolean     not null default false, -- was deduction on when this was recorded
  sold_at         timestamptz not null,
  primary key (subscription_id, slot_number, delivery_date, inventory_id)
);

create index if not exists sdu_inventory_sold_idx on public.subscription_delivery_usage (inventory_id, sold_at);
create index if not exists sdu_delivery_idx       on public.subscription_delivery_usage (subscription_id, slot_number, delivery_date);

alter table public.subscription_delivery_usage enable row level security;
drop policy if exists staff_read_subscription_delivery_usage on public.subscription_delivery_usage;
create policy staff_read_subscription_delivery_usage on public.subscription_delivery_usage
  for select using (public.is_owner_or_staff());

grant select on public.subscription_delivery_usage to authenticated;
grant all    on public.subscription_delivery_usage to service_role;

-- ── Everything sales have used, from every source ────────────────────────────
create or replace view public.inventory_usage_history
with (security_invoker = true) as
  select inventory_id, sold_at, base_amount, 'app'::text as source
    from public.order_inventory_usage
  union all
  select inventory_id, sold_at, base_amount, 'register'::text
    from public.square_line_inventory_usage
  union all
  select inventory_id, sold_at, base_amount, 'subscription'::text
    from public.subscription_delivery_usage;

grant select on public.inventory_usage_history to authenticated;

-- ── Which menu item a delivered drink was ────────────────────────────────────
-- The slot's drink when its name still matches what was snapshotted at close-out
-- (the slot may have changed since), else the menu item of that name.
create or replace function public.subscription_delivery_menu_item(
  p_subscription_id uuid, p_slot_number integer, p_drink_name text
)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select mi.id
       from public.subscription_drink_slots sds
       join public.menu_items mi on mi.id = sds.drink_item_id
      where sds.subscription_id = p_subscription_id
        and sds.slot_number = p_slot_number
        and lower(btrim(mi.name)) = lower(btrim(p_drink_name))
      limit 1),
    (select m.id
       from public.menu_items m
      where lower(btrim(m.name)) = lower(btrim(p_drink_name))
      order by m.retired, m.in_square desc, m.created_at desc
      limit 1)
  );
$$;

-- ── Work out one delivered drink ─────────────────────────────────────────────
-- Does nothing if it was already recorded, so closing it out twice can't take
-- the stock off twice.
create or replace function public.record_subscription_delivery_usage(
  p_subscription_id uuid, p_slot_number integer, p_delivery_date date, p_apply boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.subscription_deliveries%rowtype;
  v_item uuid;
  v_take numeric;
  v_at   timestamptz;
  n      integer := 0;
  r      record;
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
  if v_item is null then
    return 0;
  end if;

  -- Midday Central on the day it was delivered, like Item Lookup shows it.
  v_at := (p_delivery_date::timestamp + interval '12 hours') at time zone 'America/Chicago';

  for r in
    select u.inventory_id, sum(u.amount) as base_amount
    from public.menu_item_usage(
      v_item,
      coalesce(
        array(
          select x->>'catalogObjectId'
          from jsonb_array_elements(
                 case when jsonb_typeof(v_row.drink_modifiers) = 'array' then v_row.drink_modifiers else '[]'::jsonb end
               ) x
          where jsonb_typeof(x) = 'object' and nullif(x->>'catalogObjectId', '') is not null
        ),
        '{}'::text[]
      )
    ) u
    group by u.inventory_id
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

-- ── Put a drink back ─────────────────────────────────────────────────────────
create or replace function public.release_subscription_delivery_usage(
  p_subscription_id uuid, p_slot_number integer, p_delivery_date date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select * from public.subscription_delivery_usage
    where subscription_id = p_subscription_id and slot_number = p_slot_number and delivery_date = p_delivery_date
  loop
    if r.applied_amount > 0 then
      update public.inventory
      set quantity = coalesce(quantity, 0) + r.applied_amount, updated_at = now()
      where id = r.inventory_id;
    end if;
    n := n + 1;
  end loop;

  delete from public.subscription_delivery_usage
  where subscription_id = p_subscription_id and slot_number = p_slot_number and delivery_date = p_delivery_date;
  return n;
end;
$$;

revoke all on function public.record_subscription_delivery_usage(uuid, integer, date, boolean) from public, anon, authenticated;
revoke all on function public.release_subscription_delivery_usage(uuid, integer, date)          from public, anon, authenticated;
grant execute on function public.record_subscription_delivery_usage(uuid, integer, date, boolean) to service_role;
grant execute on function public.release_subscription_delivery_usage(uuid, integer, date)          to service_role;

-- ── The trigger ──────────────────────────────────────────────────────────────
create or replace function public.subscription_deliveries_inventory_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.status = 'delivered' then
      perform public.record_subscription_delivery_usage(
        new.subscription_id, new.slot_number, new.delivery_date,
        coalesce((select deduct_subscriptions from public.inventory_settings where id), false)
      );
    elsif new.status = 'cancelled' then
      perform public.release_subscription_delivery_usage(new.subscription_id, new.slot_number, new.delivery_date);
    end if;
  exception when others then
    -- Never let stock bookkeeping stop a drink from being closed out.
    raise warning 'subscription_deliveries_inventory_trigger: drink %/%/% not recorded: %',
      new.subscription_id, new.slot_number, new.delivery_date, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists subscription_deliveries_inventory on public.subscription_deliveries;
create trigger subscription_deliveries_inventory
  after insert or update of status on public.subscription_deliveries
  for each row execute function public.subscription_deliveries_inventory_trigger();

-- ── Putting a drink back on the queue ────────────────────────────────────────
-- set_subscription_delivery_status() as of 20260914_subscriber_display_names.sql,
-- with one addition: putting a drink back ('paid') first returns what it took.
-- (That branch deletes the delivery row, and a delete is not caught by the
-- trigger above, so it is done here.)
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

-- ── Past drinks ──────────────────────────────────────────────────────────────
-- Records what drinks closed out before this migration used, WITHOUT touching
-- stock, for forecasting. p_rebuild = true first clears what was recorded without
-- deducting, so history is redone from today's Usage Setup. Returns how many
-- drinks it recorded.
create or replace function public.backfill_subscription_usage(p_rebuild boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  if auth.uid() is not null and not public.is_owner_or_staff() then
    raise exception 'Only admins and managers can rebuild usage history';
  end if;

  if p_rebuild then
    delete from public.subscription_delivery_usage where applied = false;
  end if;

  for r in
    select d.subscription_id, d.slot_number, d.delivery_date
    from public.subscription_deliveries d
    where d.status = 'delivered'
      and not exists (select 1 from public.subscription_delivery_usage u
                       where u.subscription_id = d.subscription_id and u.slot_number = d.slot_number
                         and u.delivery_date = d.delivery_date)
  loop
    if public.record_subscription_delivery_usage(r.subscription_id, r.slot_number, r.delivery_date, false) > 0 then
      n := n + 1;
    end if;
  end loop;

  return n;
end;
$$;

revoke all on function public.backfill_subscription_usage(boolean) from public, anon;
grant execute on function public.backfill_subscription_usage(boolean) to authenticated, service_role;

-- Check it:
--   select u.sold_at, d.drink_name, d.customer_name, i.name, u.base_amount, i.base_unit, u.applied_amount, i.unit
--   from public.subscription_delivery_usage u
--   join public.subscription_deliveries d
--     on d.subscription_id = u.subscription_id and d.slot_number = u.slot_number and d.delivery_date = u.delivery_date
--   join public.inventory i on i.id = u.inventory_id
--   order by u.sold_at desc limit 50;
