-- Inventory in the unit orders come in.
--
-- Until now an item's count was in whatever people counted by eye (bottles, tubs,
-- sleeves) and every recipe, sale and receipt had to be converted to it. This
-- lets an item be kept in its ORDERING unit instead -- oz for syrup and boba,
-- individual cups for cups -- so usage, receipts and the forecast all speak the
-- same unit and no conversion is needed.
--
-- Counting by eye stays easy: the old unit is kept as a "count unit". A student
-- enters "3 bottles" and it is saved as 96 oz; screens show both, "96 oz
-- (3 bottles)".
--
--   inventory.unit                  the unit stock is kept in (oz, each)
--   inventory.quantity, par_level   in that unit
--   inventory.base_units_per_unit   1 once converted (so every usage, deduction and
--                                   forecast function works unchanged)
--   inventory.count_unit            the by-eye unit, e.g. "Bottles" (null = none)
--   inventory.count_unit_size       how many of `unit` are in one count unit (32 oz)
--
-- convert_inventory_to_base_units() does one item at a time, only when a person has
-- approved it (Admin > Usage Setup > Units): it needs the item's base_unit (what
-- recipes measure in) and base_units_per_unit (how many are in one counted unit). It
-- scales everything that was written in the old unit by that factor -- the count and
-- par level, the usage already recorded for orders, register sales and subscription
-- drinks (so cancelling an old order still puts back the right amount), and the
-- "counts as" on pending orders, remembered receipt matches and saved products.
-- revert_inventory_to_counted_units() undoes it with the inverse factor.
--
-- Old inventory_log rows stay in the unit they were written in.
-- Safe to run more than once.

alter table public.inventory
  add column if not exists count_unit      text,
  add column if not exists count_unit_size numeric check (count_unit_size is null or count_unit_size > 0);

comment on column public.inventory.count_unit is
  'What people count this by eye (Bottles, Tubs). Null when it is counted in `unit` itself.';
comment on column public.inventory.count_unit_size is
  'How many `unit` are in one count_unit: a bottle of syrup = 32 (oz).';

-- ── What was changed, for the record and for undoing ─────────────────────────
create table if not exists public.inventory_unit_conversions (
  id           uuid primary key default gen_random_uuid(),
  inventory_id uuid references public.inventory(id) on delete cascade,
  item_name    text not null,
  action       text not null check (action in ('converted', 'reverted')),
  old_unit     text,
  new_unit     text,
  factor       numeric not null,
  quantity_before numeric,
  quantity_after  numeric,
  done_by      uuid references auth.users(id),
  done_at      timestamptz not null default now()
);

alter table public.inventory_unit_conversions enable row level security;
drop policy if exists staff_read_inventory_unit_conversions on public.inventory_unit_conversions;
create policy staff_read_inventory_unit_conversions on public.inventory_unit_conversions
  for select using (public.is_owner_or_staff());
grant select on public.inventory_unit_conversions to authenticated;
grant all    on public.inventory_unit_conversions to service_role;

-- ── Scale everything written in an item's old unit ───────────────────────────
-- p_factor multiplies each amount. Tables that don't exist yet (a phase not run)
-- are skipped.
create or replace function public.scale_inventory_amounts(p_inventory_id uuid, p_factor numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
begin
  -- What sales already took off the count, so cancelling one restores the right amount.
  foreach t in array array['order_inventory_usage', 'square_line_inventory_usage', 'subscription_delivery_usage'] loop
    if to_regclass('public.' || t) is not null then
      execute format('update public.%I set applied_amount = round(applied_amount * $1, 4) where inventory_id = $2 and applied_amount > 0', t)
        using p_factor, p_inventory_id;
    end if;
  end loop;

  -- "One purchase adds N" on remembered matches and saved products.
  foreach t in array array['inventory_aliases', 'inventory_reorder'] loop
    if to_regclass('public.' || t) is not null then
      execute format('update public.%I set counted_per_purchase = round(counted_per_purchase * $1, 4) where inventory_id = $2 and counted_per_purchase is not null', t)
        using p_factor, p_inventory_id;
    end if;
  end loop;

  -- ...and on orders still to arrive. Received orders are history, left as written.
  if to_regclass('public.purchase_order_items') is not null then
    update public.purchase_order_items poi
       set counted_per_purchase = round(poi.counted_per_purchase * p_factor, 4)
      from public.purchase_orders po
     where po.id = poi.purchase_order_id
       and po.status in ('pending', 'partial', 'needs_receipt')
       and poi.inventory_id = p_inventory_id
       and poi.counted_per_purchase is not null;
  end if;
end;
$$;

revoke all on function public.scale_inventory_amounts(uuid, numeric) from public, anon, authenticated;
grant execute on function public.scale_inventory_amounts(uuid, numeric) to service_role;

-- ── Convert items to their ordering unit ─────────────────────────────────────
-- Returns { converted: n, skipped: [{ id, name, reason }] }.
create or replace function public.convert_inventory_to_base_units(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  r         public.inventory%rowtype;
  f         numeric;
  n         integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_reason  text;
begin
  if auth.uid() is not null and not public.is_owner_or_staff() then
    raise exception 'Only admins and managers can change inventory units';
  end if;

  foreach v_id in array coalesce(p_ids, '{}'::uuid[]) loop
    select * into r from public.inventory where id = v_id for update;
    if not found then
      continue;
    end if;

    f := r.base_units_per_unit;
    v_reason := case
      when nullif(btrim(coalesce(r.base_unit, '')), '') is null then 'no recipe unit set'
      when not (coalesce(f, 0) > 0)                             then 'no conversion set'
      when r.count_unit_size is not null                        then 'already converted'
      when f = 1 and lower(btrim(coalesce(r.unit, ''))) = lower(btrim(r.base_unit)) then 'already in that unit'
    end;
    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('id', v_id, 'name', r.name, 'reason', v_reason));
      continue;
    end if;

    update public.inventory
       set count_unit          = case when f <> 1 then r.unit end,
           count_unit_size     = case when f <> 1 then f end,
           quantity            = round(coalesce(r.quantity, 0) * f, 4),
           par_level           = round(coalesce(r.par_level, 0) * f, 4),
           unit                = r.base_unit,
           base_units_per_unit = 1,
           updated_at          = now()
     where id = v_id;

    perform public.scale_inventory_amounts(v_id, f);

    insert into public.inventory_unit_conversions
      (inventory_id, item_name, action, old_unit, new_unit, factor, quantity_before, quantity_after, done_by)
    values (v_id, r.name, 'converted', r.unit, r.base_unit, f, r.quantity, round(coalesce(r.quantity, 0) * f, 4), auth.uid());

    n := n + 1;
  end loop;

  return jsonb_build_object('converted', n, 'skipped', v_skipped);
end;
$$;

-- ── Undo it ──────────────────────────────────────────────────────────────────
create or replace function public.revert_inventory_to_counted_units(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  r         public.inventory%rowtype;
  f         numeric;
  n         integer := 0;
  v_skipped jsonb := '[]'::jsonb;
begin
  if auth.uid() is not null and not public.is_owner_or_staff() then
    raise exception 'Only admins and managers can change inventory units';
  end if;

  foreach v_id in array coalesce(p_ids, '{}'::uuid[]) loop
    select * into r from public.inventory where id = v_id for update;
    if not found then
      continue;
    end if;

    f := r.count_unit_size;
    if not (coalesce(f, 0) > 0) or nullif(btrim(coalesce(r.count_unit, '')), '') is null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('id', v_id, 'name', r.name, 'reason', 'not converted'));
      continue;
    end if;

    update public.inventory
       set quantity            = round(coalesce(r.quantity, 0) / f, 4),
           par_level           = round(coalesce(r.par_level, 0) / f, 4),
           unit                = r.count_unit,
           base_units_per_unit = f,
           count_unit          = null,
           count_unit_size     = null,
           updated_at          = now()
     where id = v_id;

    perform public.scale_inventory_amounts(v_id, 1 / f);

    insert into public.inventory_unit_conversions
      (inventory_id, item_name, action, old_unit, new_unit, factor, quantity_before, quantity_after, done_by)
    values (v_id, r.name, 'reverted', r.unit, r.count_unit, f, r.quantity, round(coalesce(r.quantity, 0) / f, 4), auth.uid());

    n := n + 1;
  end loop;

  return jsonb_build_object('reverted', n, 'skipped', v_skipped);
end;
$$;

revoke all on function public.convert_inventory_to_base_units(uuid[])      from public, anon;
revoke all on function public.revert_inventory_to_counted_units(uuid[])    from public, anon;
grant execute on function public.convert_inventory_to_base_units(uuid[])   to authenticated, service_role;
grant execute on function public.revert_inventory_to_counted_units(uuid[]) to authenticated, service_role;

-- Check it:
--   select name, unit, quantity, par_level, count_unit, count_unit_size, base_unit, base_units_per_unit
--   from public.inventory order by category, name;
--   select * from public.inventory_unit_conversions order by done_at desc limit 20;
