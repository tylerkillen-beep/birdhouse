-- Needs Ordering: what to order, how much, and by when.
--
-- Run after the usage migrations (20260925_*_deduction.sql): the forecast reads
-- inventory_usage_history, the sales-based usage they record.
--
-- For every inventory item, inventory_forecast() works out
--
--   avg_daily     what it uses per OPEN school day, from the last 28 days of sales
--                 (weekends and Closed Days in blocked_dates don't count)
--   days_left     (count + what's already on order) / avg_daily
--   run_out_date  that many open days from today
--   order_by_date run_out_date minus the lead time -- the last day to order
--
-- and files it as order_now (order_by is today or past), soon (within 3 days)
-- or ok. An item with no recorded usage falls back to its par level: at or below
-- par is order_now. The suggestion is enough to last lead time + cover days.
--
-- Lead time comes from the item's vendor (Amazon 3 days, Walmart 2, other 3 by
-- default, editable in inventory_settings) or an override on the item. Cover is
-- 7 open days by default. Both are open days.
--
-- inventory_reorder is each item's usual product: vendor, product link, and how
-- many counted units one purchase adds. seed_reorder_profiles() fills it in from
-- past receipts. place_reorder() records an order you placed so managers confirm
-- it arriving, and it counts as on order until then.
--
-- Safe to run more than once.

-- ── Settings ─────────────────────────────────────────────────────────────────
alter table public.inventory_settings
  add column if not exists reorder_lead_days_amazon  integer not null default 3,
  add column if not exists reorder_lead_days_walmart integer not null default 2,
  add column if not exists reorder_lead_days_other   integer not null default 3,
  add column if not exists reorder_cover_days        integer not null default 7,
  add column if not exists reorder_lookback_days     integer not null default 28;

-- ── Each item's usual product ────────────────────────────────────────────────
create table if not exists public.inventory_reorder (
  inventory_id         uuid primary key references public.inventory(id) on delete cascade,
  vendor               text not null default 'other' check (vendor in ('amazon', 'walmart', 'other')),
  product_name         text,
  product_url          text,
  counted_per_purchase numeric check (counted_per_purchase is null or counted_per_purchase > 0),
  lead_days            integer check (lead_days is null or lead_days >= 0),
  cover_days           integer check (cover_days is null or cover_days >= 0),
  notes                text,
  updated_by           uuid references auth.users(id),
  updated_at           timestamptz not null default now()
);

alter table public.inventory_reorder enable row level security;
drop policy if exists staff_all_inventory_reorder on public.inventory_reorder;
create policy staff_all_inventory_reorder on public.inventory_reorder
  for all using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

grant select, insert, update, delete on public.inventory_reorder to authenticated;
grant all on public.inventory_reorder to service_role;

-- Where an order came from: 'needs_ordering' when placed from the list. A receipt
-- uploaded later can be attached to such an order instead of making a second one.
alter table public.purchase_orders add column if not exists source text;

-- ── The school calendar ──────────────────────────────────────────────────────
-- Open days are weekdays that aren't in blocked_dates (Admin > Closed Days).
create or replace function public.open_days_between(p_from date, p_to date)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from generate_series(p_from, p_to, interval '1 day') g(d)
  where extract(isodow from g.d) between 1 and 5
    and not exists (select 1 from public.blocked_dates b where b.date = g.d::date);
$$;

-- The date that is p_n open days after p_from (p_n = 0 is p_from itself).
create or replace function public.open_day_after(p_from date, p_n integer)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select case when coalesce(p_n, 0) <= 0 then p_from else (
    select x.d
    from (
      select g.d::date as d, row_number() over (order by g.d) as rn
      from generate_series(p_from + 1, p_from + least(p_n, 400) * 2 + 14, interval '1 day') g(d)
      where extract(isodow from g.d) between 1 and 5
        and not exists (select 1 from public.blocked_dates b where b.date = g.d::date)
    ) x
    where x.rn = least(p_n, 400)
    limit 1
  ) end;
$$;

revoke all on function public.open_days_between(date, date) from public, anon;
revoke all on function public.open_day_after(date, integer) from public, anon;
grant execute on function public.open_days_between(date, date) to authenticated;
grant execute on function public.open_day_after(date, integer) to authenticated;

-- ── The forecast ─────────────────────────────────────────────────────────────
create or replace function public.inventory_forecast()
returns table (
  inventory_id         uuid,
  name                 text,
  category             text,
  unit                 text,
  quantity             numeric,
  par_level            numeric,
  on_order             numeric,
  avg_daily            numeric,
  days_left            numeric,
  run_out_date         date,
  order_by_date        date,
  lead_days            integer,
  cover_days           integer,
  status               text,
  reason               text,
  suggested_units      numeric,
  suggested_packs      numeric,
  vendor               text,
  product_name         text,
  product_url          text,
  counted_per_purchase numeric,
  has_profile          boolean,
  needs_conversion     boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_cfg   public.inventory_settings%rowtype;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_look  integer;
  v_open  integer;
  v_from  timestamptz;
  v_to    timestamptz;
begin
  if not public.is_owner_or_staff() then
    raise exception 'Only admins and managers can see the ordering forecast';
  end if;

  select * into v_cfg from public.inventory_settings where id;
  v_look := greatest(coalesce(v_cfg.reorder_lookback_days, 28), 7);
  v_open := greatest(public.open_days_between(v_today - v_look, v_today - 1), 1);
  v_from := (v_today - v_look)::timestamp at time zone 'America/Chicago';
  v_to   := v_today::timestamp at time zone 'America/Chicago';

  return query
  with used as (
    select h.inventory_id, sum(h.base_amount) as base_used
      from public.inventory_usage_history h
     where h.sold_at >= v_from and h.sold_at < v_to
     group by h.inventory_id
  ),
  incoming as (
    select poi.inventory_id,
           sum(greatest(poi.quantity - coalesce(poi.received_quantity, 0), 0) * coalesce(poi.counted_per_purchase, 1)) as units
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
     where po.status in ('pending', 'partial') and poi.inventory_id is not null
     group by poi.inventory_id
  ),
  base as (
    select i.id                                   as inventory_id,
           i.name::text                           as name,
           i.category::text                       as category,
           i.unit::text                           as unit,
           coalesce(i.quantity, 0)::numeric       as quantity,
           coalesce(i.par_level, 0)::numeric      as par_level,
           coalesce(inc.units, 0)::numeric        as on_order,
           (i.base_units_per_unit is null or i.base_units_per_unit <= 0) as needs_conversion,
           case when i.base_units_per_unit > 0
                then coalesce(u.base_used, 0) / i.base_units_per_unit / v_open end as daily,
           r.vendor::text                         as vendor,
           r.product_name::text                   as product_name,
           r.product_url::text                    as product_url,
           r.counted_per_purchase::numeric        as cpp,
           (r.inventory_id is not null)           as has_profile,
           coalesce(r.lead_days,
                    case coalesce(r.vendor, 'other')
                      when 'amazon'  then v_cfg.reorder_lead_days_amazon
                      when 'walmart' then v_cfg.reorder_lead_days_walmart
                      else v_cfg.reorder_lead_days_other end)::integer as lead,
           coalesce(r.cover_days, v_cfg.reorder_cover_days)::integer    as cover
      from public.inventory i
      left join used     u   on u.inventory_id   = i.id
      left join incoming inc on inc.inventory_id = i.id
      left join public.inventory_reorder r on r.inventory_id = i.id
  ),
  calc as (
    select b.*,
           (b.quantity + b.on_order) as stock,
           case when b.daily > 0 then (b.quantity + b.on_order) / b.daily end as dleft
      from base b
  ),
  dated as (
    select c.*,
           case when c.dleft is not null then public.open_day_after(v_today, ceil(c.dleft)::integer) end as run_out,
           case when c.dleft is not null then public.open_day_after(v_today, ceil(c.dleft)::integer) - c.lead end as order_by
      from calc c
  ),
  graded as (
    select d.*,
           case
             when d.daily > 0 and d.order_by <= v_today                   then 'order_now'
             when d.daily > 0 and d.order_by <= v_today + 3               then 'soon'
             when d.daily > 0                                              then 'ok'
             when d.par_level > 0 and d.stock <= d.par_level               then 'order_now'
             else 'ok'
           end as status,
           case
             when d.daily > 0 and d.order_by <= v_today then
               case when d.stock <= 0 then 'out of stock' else 'runs out ' || to_char(d.run_out, 'FMMon FMDD') end
             when d.daily > 0 and d.order_by <= v_today + 3 then 'runs out ' || to_char(d.run_out, 'FMMon FMDD')
             when d.daily > 0 then null
             when d.par_level > 0 and d.stock <= d.par_level then 'at or below par'
             else null
           end as reason,
           case
             when d.daily > 0 then greatest(d.daily * (d.lead + d.cover) - d.stock, 0)
             when d.par_level > 0 then greatest(d.par_level - d.stock, 0)
             else 0
           end as need
      from dated d
  )
  select g.inventory_id, g.name, g.category, g.unit, g.quantity, g.par_level, g.on_order,
         g.daily, g.dleft, g.run_out, g.order_by, g.lead, g.cover,
         g.status, g.reason,
         round(g.need, 2),
         case when g.status in ('order_now', 'soon')
              then greatest(ceil(g.need / coalesce(g.cpp, 1)), 1)
              else ceil(g.need / coalesce(g.cpp, 1)) end,
         g.vendor, g.product_name, g.product_url, g.cpp, g.has_profile, g.needs_conversion
    from graded g
   order by case g.status when 'order_now' then 0 when 'soon' then 1 else 2 end,
            g.order_by nulls last, g.name;
end;
$$;

revoke all on function public.inventory_forecast() from public, anon;
grant execute on function public.inventory_forecast() to authenticated;

-- ── Fill the products in from past receipts ──────────────────────────────────
-- For each item that has appeared on a receipt: that receipt's vendor, product
-- wording, and counted-per-purchase. Items that already have a product are left
-- alone. Returns how many were added. Product links have to be added by hand --
-- receipts don't carry them.
create or replace function public.seed_reorder_profiles()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if auth.uid() is not null and not public.is_owner_or_staff() then
    raise exception 'Only admins and managers can set up products';
  end if;

  insert into public.inventory_reorder (inventory_id, vendor, product_name, counted_per_purchase, updated_by)
  select distinct on (poi.inventory_id)
         poi.inventory_id, po.vendor, poi.raw_name, poi.counted_per_purchase, auth.uid()
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
   where poi.inventory_id is not null
   order by poi.inventory_id, po.order_date desc nulls last, po.created_at desc
  on conflict (inventory_id) do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.seed_reorder_profiles() from public, anon;
grant execute on function public.seed_reorder_profiles() to authenticated;

-- ── Record an order you placed ───────────────────────────────────────────────
-- p_lines: [{ inventory_id, raw_name, quantity, counted_per_purchase }]
--   quantity is in purchased units (packs), counted_per_purchase is how many
--   counted units one adds. The order is pending: managers confirm it arriving,
--   and until then the forecast counts it as on order. Returns the order id.
create or replace function public.place_reorder(
  p_vendor       text,
  p_lines        jsonb,
  p_order_number text default null,
  p_expected     date default null,
  p_notes        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po    uuid;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_line  jsonb;
begin
  if not public.is_owner_or_staff() then
    raise exception 'Only admins and managers can place orders';
  end if;
  if p_vendor not in ('amazon', 'walmart', 'other') then
    raise exception 'Unknown vendor: %', p_vendor;
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one item to the order';
  end if;

  insert into public.purchase_orders (vendor, order_number, order_date, expected_arrival, status, notes, created_by, source)
  values (p_vendor, nullif(btrim(p_order_number), ''), v_today, p_expected, 'pending', nullif(btrim(p_notes), ''), auth.uid(), 'needs_ordering')
  returning id into v_po;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.purchase_order_items (purchase_order_id, raw_name, inventory_id, quantity, counted_per_purchase)
    values (
      v_po,
      coalesce(nullif(btrim(v_line ->> 'raw_name'), ''), 'Item'),
      nullif(v_line ->> 'inventory_id', '')::uuid,
      greatest(coalesce((v_line ->> 'quantity')::numeric, 1), 0),
      nullif((v_line ->> 'counted_per_purchase')::numeric, 0)
    );

    if nullif(v_line ->> 'inventory_id', '') is not null then
      update public.inventory
         set last_ordered_at = v_today, expected_arrival = p_expected, updated_at = now()
       where id = (v_line ->> 'inventory_id')::uuid;
    end if;
  end loop;

  return v_po;
end;
$$;

revoke all on function public.place_reorder(text, jsonb, text, date, text) from public, anon;
grant execute on function public.place_reorder(text, jsonb, text, date, text) to authenticated;

-- Check it (signed in as staff in the app; the SQL editor has no signed-in user,
-- so the forecast raises there). To see the raw ingredients from the editor:
--   select h.inventory_id, i.name, sum(h.base_amount / nullif(i.base_units_per_unit, 0)) as used_28_days
--   from public.inventory_usage_history h join public.inventory i on i.id = h.inventory_id
--   where h.sold_at > now() - interval '28 days' group by 1, 2 order by 3 desc nulls last;
