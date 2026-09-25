-- Inventory usage, phase 2: paid app orders take stock off the shelf.
--
-- Every website order records what it used (menu_item_usage(), the same
-- function the Usage Setup preview runs) in order_inventory_usage. Whether that
-- also lowers inventory.quantity is a switch, inventory_settings.deduct_orders,
-- OFF until you flip it on Admin > Usage Setup. That lets usage history build up
-- and lets you take a starting count before the numbers start moving.
--
--   paid / preparing / ready / delivered   -> record usage (once per order)
--   cancelled / refunded                   -> put back exactly what was taken
--
-- What was taken off is stored per order (applied_amount), so a cancel restores
-- the same amount even if Usage Setup changed since. Units: menu_item_usage()
-- is in each item's recipe unit (base_unit); inventory.quantity is in counted
-- units (bottles, sleeves), so each line is divided by base_units_per_unit.
-- An item with no conversion is recorded but not deducted.
--
-- Stock never goes below 0: a count that was stale simply stops at 0. The full
-- usage is still in base_amount, so history and forecasts stay honest.
--
-- The trigger can never stop an order: any failure inside it is logged as a
-- warning and the order goes through untouched.
--
-- Not deducted here: sticker orders, Square register sales and subscription
-- drinks (phase 3). Safe to run more than once.

-- ── The switch ───────────────────────────────────────────────────────────────
create table if not exists public.inventory_settings (
  id                boolean primary key default true check (id),
  deduct_orders     boolean not null default false,
  deduct_enabled_at timestamptz,
  updated_by        uuid references auth.users(id),
  updated_at        timestamptz not null default now()
);

insert into public.inventory_settings (id) values (true) on conflict (id) do nothing;

-- ── What each order used ─────────────────────────────────────────────────────
create table if not exists public.order_inventory_usage (
  order_id       uuid    not null references public.orders(id) on delete cascade,
  inventory_id   uuid    not null references public.inventory(id) on delete cascade,
  base_amount    numeric not null,                 -- in inventory.base_unit
  applied_amount numeric not null default 0,       -- counted units taken off inventory.quantity
  applied        boolean not null default false,   -- was deduction on when this was recorded
  sold_at        timestamptz not null default now(),   -- when the order was placed
  primary key (order_id, inventory_id)
);

create index if not exists oiu_inventory_sold_idx on public.order_inventory_usage (inventory_id, sold_at);
create index if not exists oiu_sold_idx           on public.order_inventory_usage (sold_at);

-- Staff read; only the functions below write (they run with definer rights).
alter table public.inventory_settings    enable row level security;
alter table public.order_inventory_usage enable row level security;

drop policy if exists staff_read_inventory_settings   on public.inventory_settings;
drop policy if exists staff_update_inventory_settings on public.inventory_settings;
create policy staff_read_inventory_settings   on public.inventory_settings for select using (public.is_owner_or_staff());
create policy staff_update_inventory_settings on public.inventory_settings for update
  using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

drop policy if exists staff_read_order_inventory_usage on public.order_inventory_usage;
create policy staff_read_order_inventory_usage on public.order_inventory_usage for select using (public.is_owner_or_staff());

grant select, update on public.inventory_settings    to authenticated;
grant select         on public.order_inventory_usage to authenticated;
grant all            on public.inventory_settings    to service_role;
grant all            on public.order_inventory_usage to service_role;

-- ── What one order uses ──────────────────────────────────────────────────────
-- Each cart line's usage (item + the add-ons picked) times its quantity, added
-- up per inventory item. Lines that are not menu items (sticker sheets) and
-- ids that are not menu item ids are skipped.
create or replace function public.order_usage(p_order_id uuid)
returns table (inventory_id uuid, base_amount numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select u.inventory_id, sum(u.amount * v.qty)
  from public.orders o
  cross join lateral jsonb_array_elements(
         case when jsonb_typeof(o.cart_items) = 'array' then o.cart_items else '[]'::jsonb end
       ) as l(line)
  cross join lateral (
    select greatest(coalesce(nullif(l.line->>'quantity', '')::numeric, 1), 0) as qty
  ) v
  cross join lateral public.menu_item_usage(
    case when l.line->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (l.line->>'id')::uuid end,
    coalesce(
      array(
        select m->>'catalogObjectId'
        from jsonb_array_elements(
               case when jsonb_typeof(l.line->'selectedModifiers') = 'array'
                    then l.line->'selectedModifiers' else '[]'::jsonb end
             ) m
        where nullif(m->>'catalogObjectId', '') is not null
      ),
      '{}'::text[]
    )
  ) u
  where o.id = p_order_id
    and coalesce(o.order_type, 'menu') <> 'stickers'
    and coalesce(l.line->>'type', '') = ''
  group by u.inventory_id;
$$;

-- ── Record (and optionally deduct) one order ─────────────────────────────────
-- Does nothing if the order was already recorded, so a repeat status change
-- can't take the stock off twice.
create or replace function public.record_order_usage(p_order_id uuid, p_apply boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r      record;
  v_qty  numeric;
  v_per  numeric;
  v_take numeric;
  n      integer := 0;
begin
  if exists (select 1 from public.order_inventory_usage where order_id = p_order_id) then
    return 0;
  end if;

  for r in select * from public.order_usage(p_order_id) loop
    v_take := 0;
    if p_apply then
      select quantity, base_units_per_unit into v_qty, v_per
      from public.inventory where id = r.inventory_id for update;

      if found and v_per > 0 then
        v_take := round(least(r.base_amount / v_per, greatest(coalesce(v_qty, 0), 0)), 4);
        if v_take > 0 then
          update public.inventory
          set quantity = coalesce(quantity, 0) - v_take, updated_at = now()
          where id = r.inventory_id;
        end if;
      end if;
    end if;

    -- Stamped with when the order was placed, so rebuilt history lands on the
    -- right days rather than all on the day it was rebuilt.
    insert into public.order_inventory_usage (order_id, inventory_id, base_amount, applied_amount, applied, sold_at)
    values (p_order_id, r.inventory_id, r.base_amount, v_take, p_apply,
            coalesce((select created_at from public.orders where id = p_order_id), now()));
    n := n + 1;
  end loop;

  return n;
end;
$$;

-- ── Put a cancelled order back ───────────────────────────────────────────────
create or replace function public.release_order_usage(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select * from public.order_inventory_usage where order_id = p_order_id loop
    if r.applied_amount > 0 then
      update public.inventory
      set quantity = coalesce(quantity, 0) + r.applied_amount, updated_at = now()
      where id = r.inventory_id;
    end if;
    n := n + 1;
  end loop;

  delete from public.order_inventory_usage where order_id = p_order_id;
  return n;
end;
$$;

revoke all on function public.record_order_usage(uuid, boolean) from public, anon, authenticated;
revoke all on function public.release_order_usage(uuid)         from public, anon, authenticated;
grant execute on function public.record_order_usage(uuid, boolean) to service_role;
grant execute on function public.release_order_usage(uuid)         to service_role;

-- ── The trigger ──────────────────────────────────────────────────────────────
create or replace function public.orders_inventory_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.status in ('paid', 'preparing', 'ready', 'delivered')
       and coalesce(new.order_type, 'menu') <> 'stickers' then
      perform public.record_order_usage(
        new.id,
        coalesce((select deduct_orders from public.inventory_settings where id), false)
      );
    elsif new.status in ('cancelled', 'refunded') then
      perform public.release_order_usage(new.id);
    end if;
  exception when others then
    -- Never let stock bookkeeping stop an order from being placed or updated.
    raise warning 'orders_inventory_trigger: order % not recorded: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists orders_inventory on public.orders;
create trigger orders_inventory
  after insert or update of status on public.orders
  for each row execute function public.orders_inventory_trigger();

-- ── Past orders ──────────────────────────────────────────────────────────────
-- Records usage for orders that came before this migration, WITHOUT touching
-- stock, so history exists for forecasting. Run it again with p_rebuild = true
-- after Usage Setup improves to redo the history (only rows recorded while
-- deduction was off are redone; anything that really came off the shelf stays).
-- Returns how many orders it recorded.
create or replace function public.backfill_order_usage(p_rebuild boolean default false)
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
    delete from public.order_inventory_usage where applied = false;
  end if;

  for r in
    select o.id
    from public.orders o
    where o.status in ('paid', 'preparing', 'ready', 'delivered')
      and coalesce(o.order_type, 'menu') <> 'stickers'
      and not exists (select 1 from public.order_inventory_usage u where u.order_id = o.id)
  loop
    if public.record_order_usage(r.id, false) > 0 then
      n := n + 1;
    end if;
  end loop;

  return n;
end;
$$;

revoke all on function public.backfill_order_usage(boolean) from public, anon;
grant execute on function public.backfill_order_usage(boolean) to authenticated, service_role;

-- Check it:
--   select * from public.inventory_settings;
--   select o.created_at, o.drink_name, i.name, u.base_amount, i.base_unit, u.applied_amount, i.unit
--   from public.order_inventory_usage u
--   join public.orders o on o.id = u.order_id
--   join public.inventory i on i.id = u.inventory_id
--   order by u.sold_at desc limit 50;
--
-- What one existing order would use:
--   select i.name, u.base_amount, i.base_unit from public.order_usage('<order id>') u
--   join public.inventory i on i.id = u.inventory_id;
