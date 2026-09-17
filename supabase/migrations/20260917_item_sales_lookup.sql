-- Item Lookup: every sale of one item, from every channel, in one place.
--
-- Website orders and subscription drinks already live here. Register and
-- Square Online sales only live in Square, so the sync-square-sales edge
-- function copies them into square_sale_lines on a schedule -- read-only
-- against Square -- and walks back through the full history once.
--
-- item_sale_lines joins the three into one row per line sold, and the two
-- functions at the bottom are what the Team Hub's Item Lookup tab calls.
--
-- Safe to run more than once.

-- ── Register + Square Online sales, copied from Square ───────────────────────
create table if not exists public.square_sale_lines (
  square_order_id    text        not null,
  line_uid           text        not null,
  closed_at          timestamptz not null,
  channel            text        not null check (channel in ('register', 'square_online')),
  catalog_object_id  text,        -- the item *variation* sold
  item_name          text        not null,
  variation_name     text,
  quantity           numeric     not null,
  gross_cents        integer     not null default 0,  -- before discounts
  discount_cents     integer     not null default 0,
  net_cents          integer     not null default 0,  -- what the line brought in
  modifiers          jsonb       not null default '[]'::jsonb,  -- [{name, catalog_object_id, price_cents}]
  square_customer_id text,
  synced_at          timestamptz not null default now(),
  primary key (square_order_id, line_uid)
);

create index if not exists square_sale_lines_closed_at_idx on public.square_sale_lines (closed_at);
create index if not exists square_sale_lines_catalog_idx   on public.square_sale_lines (catalog_object_id);

-- A register line names a variation; this remembers which item each belongs
-- to, so a sale still finds its menu item after the item is renamed.
create table if not exists public.square_catalog_variations (
  variation_id   text primary key,
  item_id        text,
  item_name      text,
  variation_name text,
  fetched_at     timestamptz not null default now()
);

-- Names of customers attached to register sales. Name only -- no contact details.
create table if not exists public.square_customer_names (
  square_customer_id text primary key,
  display_name       text,
  fetched_at         timestamptz not null default now()
);

-- One row: how far the sync has got.
create table if not exists public.square_sales_sync (
  id              boolean primary key default true check (id),
  synced_through  timestamptz,  -- new sales are copied up to here
  backfill_before timestamptz,  -- history is copied from here forward
  backfill_floor  timestamptz,  -- when the Square location opened; history stops here
  backfill_done   boolean not null default false,
  last_run_at     timestamptz,
  last_error      text
);

alter table public.square_sale_lines         enable row level security;
alter table public.square_catalog_variations enable row level security;
alter table public.square_customer_names     enable row level security;
alter table public.square_sales_sync         enable row level security;

-- Only the sync (service role) writes these, and staff read sales through the
-- functions below. The sync status is the one thing the tab reads directly.
drop policy if exists "staff_read_square_sales_sync" on public.square_sales_sync;
create policy "staff_read_square_sales_sync"
  on public.square_sales_sync for select
  using (public.is_approved_staff());

-- What the sync still needs to ask Square about. Service role only.
create or replace function public.square_variations_to_learn(p_limit integer default 1000)
returns table (catalog_object_id text)
language sql
stable
set search_path = public
as $$
  select distinct sl.catalog_object_id
    from square_sale_lines sl
   where sl.catalog_object_id is not null
     and not exists (select 1 from square_catalog_variations cv where cv.variation_id = sl.catalog_object_id)
   limit p_limit;
$$;

create or replace function public.square_customers_to_learn(p_limit integer default 150)
returns table (square_customer_id text)
language sql
stable
set search_path = public
as $$
  select distinct sl.square_customer_id
    from square_sale_lines sl
   where sl.square_customer_id is not null
     and not exists (select 1 from square_customer_names cn where cn.square_customer_id = sl.square_customer_id)
   limit p_limit;
$$;

revoke all on function public.square_variations_to_learn(integer) from public, anon, authenticated;
revoke all on function public.square_customers_to_learn(integer)  from public, anon, authenticated;
grant execute on function public.square_variations_to_learn(integer) to service_role;
grant execute on function public.square_customers_to_learn(integer)  to service_role;

-- ── Every line sold, from every channel ──────────────────────────────────────
-- revenue_cents is null for subscription drinks: the plan is billed weekly,
-- not per drink. customer_key is never null -- sales with nobody attached
-- share one "anonymous" key per channel.
create or replace view public.item_sale_lines as
with raw as (
  -- Website orders
  select o.created_at                                  as sold_at,
         'website'::text                               as channel,
         o.id::text                                    as order_ref,
         case when l.line->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (l.line->>'id')::uuid end           as line_menu_item_id,
         null::text                                    as square_item_id,
         null::uuid                                    as fallback_menu_item_id,
         coalesce(nullif(l.line->>'name', ''), 'Unknown item') as item_name,
         v.qty                                         as quantity,
         round(v.unit_cents * v.qty)::bigint           as revenue_cents,
         case when nullif(l.line->>'fullPriceCents', '') is not null
              then greatest(0, round((l.line->>'fullPriceCents')::numeric * v.qty - v.unit_cents * v.qty))::bigint
         end                                           as discount_cents,
         coalesce((select jsonb_agg(coalesce(m->>'name', m#>>'{}'))
                     from jsonb_array_elements(case when jsonb_typeof(l.line->'selectedModifiers') = 'array'
                                                    then l.line->'selectedModifiers' else '[]'::jsonb end) m),
                  '[]'::jsonb)                         as modifier_names,
         'user:' || o.user_id::text                    as customer_key,
         coalesce(nullif(btrim(o.customer_name), ''), nullif(btrim(p.full_name), ''), 'Website customer') as customer_name
    from public.orders o
    cross join lateral jsonb_array_elements(
           case when jsonb_typeof(o.cart_items) = 'array' then o.cart_items else '[]'::jsonb end
         ) as l(line)
    cross join lateral (
      select coalesce(nullif(l.line->>'quantity', '')::numeric, 1) as qty,
             coalesce(nullif(l.line->>'priceCents', '')::numeric,
                      nullif(l.line->>'price', '')::numeric * 100, 0) as unit_cents
    ) v
    left join public.profiles p on p.id = o.user_id
   where o.status in ('paid', 'preparing', 'ready', 'delivered')
     and coalesce(o.order_type, 'menu') <> 'stickers'
     and coalesce(l.line->>'type', '') = ''

  union all

  -- Website orders from before carts held more than one item
  select o.created_at, 'website', o.id::text, null, null, null,
         btrim(regexp_replace(o.drink_name, '\s*\((Hot|Iced)\)\s*$', '', 'i')),
         1,
         round(coalesce(o.total_amount, 0) * 100)::bigint,
         null, '[]'::jsonb,
         'user:' || o.user_id::text,
         coalesce(nullif(btrim(o.customer_name), ''), nullif(btrim(p.full_name), ''), 'Website customer')
    from public.orders o
    left join public.profiles p on p.id = o.user_id
   where o.status in ('paid', 'preparing', 'ready', 'delivered')
     and coalesce(o.order_type, 'menu') <> 'stickers'
     and (o.cart_items is null or jsonb_typeof(o.cart_items) <> 'array' or jsonb_array_length(o.cart_items) = 0)
     and nullif(btrim(o.drink_name), '') is not null

  union all

  -- Register and Square Online
  select sl.closed_at, sl.channel, sl.square_order_id, null, cv.item_id, null,
         coalesce(nullif(cv.item_name, ''), sl.item_name),
         sl.quantity,
         sl.net_cents::bigint,
         sl.discount_cents::bigint,
         coalesce((select jsonb_agg(m->>'name') from jsonb_array_elements(sl.modifiers) m), '[]'::jsonb),
         case when sl.square_customer_id is not null then 'square:' || sl.square_customer_id
              else 'anonymous:' || sl.channel end,
         case when sl.square_customer_id is not null then coalesce(nullif(btrim(cn.display_name), ''), 'Square customer')
              when sl.channel = 'square_online' then 'Square Online (no customer attached)'
              else 'Register (no customer attached)' end
    from public.square_sale_lines sl
    left join public.square_catalog_variations cv on cv.variation_id = sl.catalog_object_id
    left join public.square_customer_names cn on cn.square_customer_id = sl.square_customer_id

  union all

  -- Subscription drinks, once staff mark them delivered
  select (sd.delivery_date::timestamp + interval '12 hours') at time zone 'America/Chicago',
         'subscription',
         sd.subscription_id::text || ':' || sd.slot_number || ':' || sd.delivery_date,
         null, null, sds.drink_item_id,
         coalesce(nullif(btrim(sd.drink_name), ''), 'Subscription drink'),
         1, null, null,
         coalesce((select jsonb_agg(coalesce(m->>'name', m#>>'{}'))
                     from jsonb_array_elements(case when jsonb_typeof(sd.drink_modifiers) = 'array'
                                                    then sd.drink_modifiers else '[]'::jsonb end) m),
                  '[]'::jsonb),
         'user:' || s.user_id::text,
         coalesce(nullif(btrim(sd.customer_name), ''), 'Subscriber')
    from public.subscription_deliveries sd
    join public.subscriptions s on s.id = sd.subscription_id
    left join public.subscription_drink_slots sds
           on sds.subscription_id = sd.subscription_id and sds.slot_number = sd.slot_number
   where sd.status = 'delivered'
)
-- Which menu item each line is: the website's own id, then the Square item,
-- then the name, and for subscription drinks the slot's current drink.
select r.sold_at, r.channel, r.order_ref, r.item_name, r.quantity,
       r.revenue_cents, r.discount_cents, r.modifier_names,
       r.customer_key, r.customer_name,
       coalesce(direct.id, by_square.id, by_name.id, fallback.id) as menu_item_id
  from raw r
  left join public.menu_items direct    on direct.id = r.line_menu_item_id
  left join public.menu_items by_square on direct.id is null and by_square.square_item_id = r.square_item_id
  left join lateral (
    select m.id from public.menu_items m
     where lower(btrim(m.name)) = lower(btrim(r.item_name))
     order by m.retired, m.in_square desc, m.created_at desc
     limit 1
  ) by_name on direct.id is null and by_square.id is null
  left join public.menu_items fallback on fallback.id = r.fallback_menu_item_id;

-- The view runs as its owner, so nobody may read it directly -- customer
-- names stay behind the staff check in the functions below.
revoke all on public.item_sale_lines from public, anon, authenticated;

-- ── Item list for the search box ─────────────────────────────────────────────
-- Every menu item (sold or not, so a brand-new item can be looked up) plus any
-- name that sold but matches no menu item, busiest first.
create or replace function public.item_sales_catalog()
returns table (
  item_key      text,
  menu_item_id  uuid,
  name          text,
  category      text,
  retired       boolean,
  units         numeric,
  revenue_cents bigint,
  first_sold    timestamptz,
  last_sold     timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_approved_staff() then
    raise exception 'Team Hub staff only' using errcode = '42501';
  end if;

  return query
  with sales as (
    select coalesce(l.menu_item_id::text, 'name:' || lower(btrim(l.item_name))) as k,
           l.menu_item_id                 as mid,
           max(l.item_name)               as nm,
           sum(l.quantity)                as u,
           coalesce(sum(l.revenue_cents), 0) as rev,
           min(l.sold_at)                 as first_at,
           max(l.sold_at)                 as last_at
      from item_sale_lines l
     group by 1, 2
  )
  select coalesce(s.k, m.id::text),
         coalesce(m.id, s.mid),
         coalesce(m.name::text, s.nm),
         m.category::text,
         coalesce(m.retired or not coalesce(m.in_square, true), false),
         coalesce(s.u, 0),
         coalesce(s.rev, 0)::bigint,
         s.first_at,
         s.last_at
    from sales s
    full join menu_items m on m.id = s.mid
   order by coalesce(s.u, 0) desc, 3;
end;
$$;

-- ── One item's full history ──────────────────────────────────────────────────
create or replace function public.item_sales_detail(p_item_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_approved_staff() then
    raise exception 'Team Hub staff only' using errcode = '42501';
  end if;

  with lines as (
    select * from item_sale_lines l
     where coalesce(l.menu_item_id::text, 'name:' || lower(btrim(l.item_name))) = p_item_key
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'units',          coalesce(sum(quantity), 0),
        'revenue_cents',  coalesce(sum(revenue_cents), 0),
        'priced_units',   coalesce(sum(quantity) filter (where revenue_cents is not null), 0),
        'discount_cents', coalesce(sum(discount_cents), 0),
        'orders',         count(distinct channel || order_ref),
        'customers',      count(distinct customer_key) filter (where customer_key not like 'anonymous:%'),
        'first_sold',     min(sold_at),
        'last_sold',      max(sold_at),
        'names_sold_as',  coalesce(jsonb_agg(distinct item_name), '[]'::jsonb)
      ) from lines
    ),
    'by_month', (
      select coalesce(jsonb_agg(x order by x.month), '[]'::jsonb) from (
        select to_char(date_trunc('month', sold_at at time zone 'America/Chicago'), 'YYYY-MM') as month,
               sum(quantity)                                              as units,
               coalesce(sum(revenue_cents), 0)                            as revenue_cents,
               coalesce(sum(quantity) filter (where channel = 'website'), 0)       as website_units,
               coalesce(sum(quantity) filter (where channel = 'register'), 0)      as register_units,
               coalesce(sum(quantity) filter (where channel = 'square_online'), 0) as square_online_units,
               coalesce(sum(quantity) filter (where channel = 'subscription'), 0)  as subscription_units
          from lines group by 1
      ) x
    ),
    'by_channel', (
      select coalesce(jsonb_agg(x order by x.units desc), '[]'::jsonb) from (
        select channel, sum(quantity) as units, coalesce(sum(revenue_cents), 0) as revenue_cents
          from lines group by 1
      ) x
    ),
    'customers', (
      select coalesce(jsonb_agg(x order by x.units desc, x.name), '[]'::jsonb) from (
        select customer_key                         as key,
               max(customer_name)                   as name,
               customer_key like 'anonymous:%'      as anonymous,
               sum(quantity)                        as units,
               coalesce(sum(revenue_cents), 0)      as revenue_cents,
               max(sold_at)                         as last_bought
          from lines group by customer_key
         order by sum(quantity) desc
         limit 50
      ) x
    ),
    'modifiers', (
      select coalesce(jsonb_agg(x order by x.units desc), '[]'::jsonb) from (
        select m.name, sum(l.quantity) as units
          from lines l
          cross join lateral jsonb_array_elements_text(l.modifier_names) as m(name)
         group by m.name
         order by sum(l.quantity) desc
         limit 15
      ) x
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.item_sales_catalog()      from public, anon;
revoke all on function public.item_sales_detail(text)   from public, anon;
grant execute on function public.item_sales_catalog()    to authenticated;
grant execute on function public.item_sales_detail(text) to authenticated;
