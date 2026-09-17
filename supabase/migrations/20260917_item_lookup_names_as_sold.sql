-- Item Lookup: keep each register sale under the name it was rung up as.
--
-- The first version named register sales by the Square item as it is named
-- now, so an item renamed in Square lost its old name, and searching the old
-- name found nothing. The view now keeps the name from the sale itself, still
-- matches the sale to its menu item by Square item id, and the item list
-- returns every name an item sold as so the search can match any of them.
--
-- Run after 20260917_item_sales_lookup.sql. Safe to run more than once.

-- ── Every line sold, from every channel ──────────────────────────────────────
-- revenue_cents is null for subscription drinks: the plan is billed weekly,
-- not per drink. customer_key is never null -- sales with nobody attached
-- share one anonymous key per channel.
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
         case when sl.item_name = 'Custom amount' then coalesce(nullif(cv.item_name, ''), sl.item_name)
              else sl.item_name end,
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
-- Which menu item each line is: the id the website saved, then the Square item,
-- then the name, and for subscription drinks the drink the slot has now.
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

-- ── Item list for the search box, with every name each item sold as ─────────
-- The return type changes, so the old function has to go first.
drop function if exists public.item_sales_catalog();

create function public.item_sales_catalog()
returns table (
  item_key      text,
  menu_item_id  uuid,
  name          text,
  category      text,
  retired       boolean,
  units         numeric,
  revenue_cents bigint,
  first_sold    timestamptz,
  last_sold     timestamptz,
  sold_as       text[]
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
           l.menu_item_id                    as mid,
           max(l.item_name)                  as nm,
           sum(l.quantity)                   as u,
           coalesce(sum(l.revenue_cents), 0) as rev,
           min(l.sold_at)                    as first_at,
           max(l.sold_at)                    as last_at,
           array_agg(distinct l.item_name)   as names
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
         s.last_at,
         coalesce(s.names, array[]::text[])
    from sales s
    full join menu_items m on m.id = s.mid
   order by coalesce(s.u, 0) desc, 3, 1;
end;
$$;

revoke all on function public.item_sales_catalog() from public, anon;
grant execute on function public.item_sales_catalog() to authenticated;
