-- Inventory usage, phase 3: register sales take stock off the shelf too.
--
-- Run after 20260925_inventory_deduction.sql (phase 2). Register and Square
-- Online sales are copied from Square into square_sale_lines every 15 minutes
-- by the sync-square-sales function, which already leaves out the website's own
-- payments, so nothing here can count an app order twice.
--
-- Each new sale line is matched to its menu item (Square item id, then name) and
-- its usage is worked out with menu_item_usage(), exactly as for app orders:
-- the item's recipe and Always-uses links plus the add-ons rung up, times the
-- quantity. It is recorded in square_line_inventory_usage.
--
-- Deduction has its own switch, inventory_settings.deduct_register, OFF until
-- you flip it in Admin > Usage Setup. Even when it is on, only sales closed
-- AFTER you turned it on come off the count. The sync also walks years of past
-- sales, and those are recorded for history (forecasting) without touching stock.
--
-- The sync writes these sales while it runs, so nothing here may slow or break
-- it: only sales from the last two days are worked out as they arrive (history
-- comes in through Rebuild, in batches), and a failure is a warning, not an error.
--
-- A sale can arrive before Square's item behind it has been looked up, so the
-- match is retried when the sync learns that item.
--
-- Not deducted: refunds (the sync only copies what was sold), custom amounts
-- with no item, and subscription drinks (next phase).
-- Safe to run more than once.

-- ── The switch ───────────────────────────────────────────────────────────────
alter table public.inventory_settings
  add column if not exists deduct_register     boolean not null default false,
  add column if not exists register_enabled_at timestamptz;

-- ── What each register line used ─────────────────────────────────────────────
-- One row per sale line once it has been worked out, whether or not it used
-- anything, so a line is never worked out twice. menu_item_id is null when the
-- line matched no menu item.
create table if not exists public.square_line_usage (
  square_order_id   text        not null,
  line_uid          text        not null,
  catalog_object_id text,
  menu_item_id      uuid        references public.menu_items(id) on delete set null,
  applied           boolean     not null default false,   -- was deduction on for this sale
  sold_at           timestamptz not null,
  primary key (square_order_id, line_uid),
  foreign key (square_order_id, line_uid)
    references public.square_sale_lines (square_order_id, line_uid) on delete cascade
);

create table if not exists public.square_line_inventory_usage (
  square_order_id text        not null,
  line_uid        text        not null,
  inventory_id    uuid        not null references public.inventory(id) on delete cascade,
  base_amount     numeric     not null,                   -- in inventory.base_unit
  applied_amount  numeric     not null default 0,         -- counted units taken off inventory.quantity
  sold_at         timestamptz not null,
  primary key (square_order_id, line_uid, inventory_id),
  foreign key (square_order_id, line_uid)
    references public.square_line_usage (square_order_id, line_uid) on delete cascade
);

create index if not exists sli_usage_inventory_sold_idx on public.square_line_inventory_usage (inventory_id, sold_at);
create index if not exists sli_usage_sold_idx           on public.square_line_inventory_usage (sold_at);
create index if not exists square_line_usage_item_idx   on public.square_line_usage (catalog_object_id) where menu_item_id is null;

alter table public.square_line_usage           enable row level security;
alter table public.square_line_inventory_usage enable row level security;

drop policy if exists staff_read_square_line_usage on public.square_line_usage;
create policy staff_read_square_line_usage on public.square_line_usage for select using (public.is_owner_or_staff());
drop policy if exists staff_read_square_line_inventory_usage on public.square_line_inventory_usage;
create policy staff_read_square_line_inventory_usage on public.square_line_inventory_usage for select using (public.is_owner_or_staff());

grant select on public.square_line_usage           to authenticated;
grant select on public.square_line_inventory_usage to authenticated;
grant all    on public.square_line_usage           to service_role;
grant all    on public.square_line_inventory_usage to service_role;

-- ── Everything sales have used, from either source ───────────────────────────
-- What the manager Inventory cards read. base_amount is in each item's recipe
-- unit; source says where the sale came from.
create or replace view public.inventory_usage_history
with (security_invoker = true) as
  select inventory_id, sold_at, base_amount, 'app'::text as source
    from public.order_inventory_usage
  union all
  select inventory_id, sold_at, base_amount, 'register'::text
    from public.square_line_inventory_usage;

grant select on public.inventory_usage_history to authenticated;

-- ── Taking stock off, shared with app orders ─────────────────────────────────
-- Takes p_base_amount (recipe units) off one item's count, converting to counted
-- units, never below 0, and returns how many counted units actually came off (0
-- when the item has no conversion). Restoring adds that number back.
create or replace function public.take_from_inventory(p_inventory_id uuid, p_base_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_qty  numeric;
  v_per  numeric;
  v_take numeric := 0;
begin
  select quantity, base_units_per_unit into v_qty, v_per
  from public.inventory where id = p_inventory_id for update;

  if found and v_per > 0 then
    v_take := round(least(p_base_amount / v_per, greatest(coalesce(v_qty, 0), 0)), 4);
    if v_take > 0 then
      update public.inventory
      set quantity = coalesce(quantity, 0) - v_take, updated_at = now()
      where id = p_inventory_id;
    end if;
  end if;
  return v_take;
end;
$$;

revoke all on function public.take_from_inventory(uuid, numeric) from public, anon, authenticated;
grant execute on function public.take_from_inventory(uuid, numeric) to service_role;

-- Phase 2's recorder, unchanged in behaviour, now using the shared step.
create or replace function public.record_order_usage(p_order_id uuid, p_apply boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r      record;
  v_take numeric;
  n      integer := 0;
begin
  if exists (select 1 from public.order_inventory_usage where order_id = p_order_id) then
    return 0;
  end if;

  for r in select * from public.order_usage(p_order_id) loop
    v_take := case when p_apply then public.take_from_inventory(r.inventory_id, r.base_amount) else 0 end;

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

-- ── Which menu item a register line is ───────────────────────────────────────
-- The Square item behind the variation sold, then the name it was rung up as --
-- the same order Item Lookup uses.
create or replace function public.register_line_menu_item(p_catalog_object_id text, p_item_name text)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select m.id
       from public.square_catalog_variations cv
       join public.menu_items m on m.square_item_id = cv.item_id
      where cv.variation_id = p_catalog_object_id
      limit 1),
    (select m.id
       from public.menu_items m
      where lower(btrim(m.name)) = lower(btrim(p_item_name))
      order by m.retired, m.in_square desc, m.created_at desc
      limit 1)
  );
$$;

-- ── Work out one register line ───────────────────────────────────────────────
-- Does nothing if the line was already worked out. Deducts only when the switch
-- is on AND the sale closed after it was turned on.
create or replace function public.record_register_line(p_square_order_id text, p_line_uid text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line  public.square_sale_lines%rowtype;
  v_cfg   public.inventory_settings%rowtype;
  v_item  uuid;
  v_apply boolean;
  v_take  numeric;
  r       record;
begin
  if exists (select 1 from public.square_line_usage where square_order_id = p_square_order_id and line_uid = p_line_uid) then
    return 0;
  end if;

  select * into v_line from public.square_sale_lines
  where square_order_id = p_square_order_id and line_uid = p_line_uid;
  if not found then
    return 0;
  end if;

  select * into v_cfg from public.inventory_settings where id;
  v_apply := coalesce(v_cfg.deduct_register, false)
             and v_cfg.register_enabled_at is not null
             and v_line.closed_at >= v_cfg.register_enabled_at;

  v_item := public.register_line_menu_item(v_line.catalog_object_id, v_line.item_name);

  insert into public.square_line_usage (square_order_id, line_uid, catalog_object_id, menu_item_id, applied, sold_at)
  values (p_square_order_id, p_line_uid, v_line.catalog_object_id, v_item, v_apply, v_line.closed_at);

  if v_item is null then
    return 1;
  end if;

  for r in
    select u.inventory_id, sum(u.amount * greatest(coalesce(v_line.quantity, 1), 0)) as base_amount
    from public.menu_item_usage(
      v_item,
      coalesce(
        array(
          select x->>'catalog_object_id'
          from jsonb_array_elements(
                 case when jsonb_typeof(v_line.modifiers) = 'array' then v_line.modifiers else '[]'::jsonb end
               ) x
          where nullif(x->>'catalog_object_id', '') is not null
        ),
        '{}'::text[]
      )
    ) u
    group by u.inventory_id
  loop
    v_take := case when v_apply then public.take_from_inventory(r.inventory_id, r.base_amount) else 0 end;
    insert into public.square_line_inventory_usage
      (square_order_id, line_uid, inventory_id, base_amount, applied_amount, sold_at)
    values (p_square_order_id, p_line_uid, r.inventory_id, r.base_amount, v_take, v_line.closed_at);
  end loop;

  return 1;
end;
$$;

revoke all on function public.record_register_line(text, text) from public, anon, authenticated;
grant execute on function public.record_register_line(text, text) to service_role;

-- ── Triggers ─────────────────────────────────────────────────────────────────
-- A new sale line: work it out now if it is recent. Older lines are history the
-- sync is copying in bulk; Rebuild records those.
create or replace function public.square_sale_lines_inventory_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.closed_at >= now() - interval '2 days' then
      perform public.record_register_line(new.square_order_id, new.line_uid);
    end if;
  exception when others then
    -- Never let stock bookkeeping stop the sales sync.
    raise warning 'square_sale_lines_inventory_trigger: line %/% not recorded: %',
      new.square_order_id, new.line_uid, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists square_sale_lines_inventory on public.square_sale_lines;
create trigger square_sale_lines_inventory
  after insert on public.square_sale_lines
  for each row execute function public.square_sale_lines_inventory_trigger();

-- The sync learns which Square item a variation belongs to just after copying
-- the sales that use it. Recent lines that matched nothing are tried again now.
create or replace function public.square_variations_inventory_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  begin
    delete from public.square_line_usage
    where catalog_object_id = new.variation_id
      and menu_item_id is null
      and sold_at >= now() - interval '2 days';

    for r in
      select sl.square_order_id, sl.line_uid
      from public.square_sale_lines sl
      where sl.catalog_object_id = new.variation_id
        and sl.closed_at >= now() - interval '2 days'
        and not exists (select 1 from public.square_line_usage u
                         where u.square_order_id = sl.square_order_id and u.line_uid = sl.line_uid)
    loop
      perform public.record_register_line(r.square_order_id, r.line_uid);
    end loop;
  exception when others then
    raise warning 'square_variations_inventory_trigger: variation % not retried: %', new.variation_id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists square_variations_inventory on public.square_catalog_variations;
create trigger square_variations_inventory
  after insert or update on public.square_catalog_variations
  for each row execute function public.square_variations_inventory_trigger();

-- ── Past sales ───────────────────────────────────────────────────────────────
-- Works out register lines that have not been done, newest first, up to p_limit
-- per call (the database limits how long one call may run, so the screen calls
-- this again until "remaining" is 0). Never touches stock: sales closed after
-- the switch was turned on were already handled as they arrived.
-- p_rebuild = true first clears what was recorded without deducting, so history
-- is redone from today's Usage Setup; do that on the first call only.
create or replace function public.backfill_register_usage(p_rebuild boolean default false, p_limit integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r         record;
  v_done    integer := 0;
  v_left    integer;
begin
  if auth.uid() is not null and not public.is_owner_or_staff() then
    raise exception 'Only admins and managers can rebuild usage history';
  end if;

  if p_rebuild then
    delete from public.square_line_usage where applied = false;
  end if;

  for r in
    select sl.square_order_id, sl.line_uid
    from public.square_sale_lines sl
    where not exists (select 1 from public.square_line_usage u
                       where u.square_order_id = sl.square_order_id and u.line_uid = sl.line_uid)
    order by sl.closed_at desc
    limit greatest(p_limit, 1)
  loop
    v_done := v_done + public.record_register_line(r.square_order_id, r.line_uid);
  end loop;

  select count(*) into v_left
  from public.square_sale_lines sl
  where not exists (select 1 from public.square_line_usage u
                     where u.square_order_id = sl.square_order_id and u.line_uid = sl.line_uid);

  return jsonb_build_object('recorded', v_done, 'remaining', v_left);
end;
$$;

revoke all on function public.backfill_register_usage(boolean, integer) from public, anon;
grant execute on function public.backfill_register_usage(boolean, integer) to authenticated, service_role;

-- Check it:
--   select l.closed_at, l.item_name, l.quantity, i.name, u.base_amount, i.base_unit, u.applied_amount, i.unit
--   from public.square_line_inventory_usage u
--   join public.square_sale_lines l on l.square_order_id = u.square_order_id and l.line_uid = u.line_uid
--   join public.inventory i on i.id = u.inventory_id
--   order by u.sold_at desc limit 50;
--
-- Register lines that matched no menu item (so used nothing), busiest first:
--   select l.item_name, count(*) as lines, sum(l.quantity) as units
--   from public.square_line_usage h
--   join public.square_sale_lines l on l.square_order_id = h.square_order_id and l.line_uid = h.line_uid
--   where h.menu_item_id is null and h.sold_at > now() - interval '30 days'
--   group by 1 order by 2 desc limit 30;
