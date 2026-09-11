-- Inventory usage, phase 1: say what every sale uses up.
--
-- The goal is stock that counts itself down: each drink sold records what it
-- used, and inventory drops without anyone typing it in. This migration is the
-- groundwork. It links sales to inventory items but deducts nothing yet.
--
-- What one sale of a menu item uses is the sum of:
--
--   1. Its recipe's build steps. Recipes store cup / syrups / boba / ... as the
--      staff-facing text the Recipe Sheet shows ("Lime (3 pumps)"), so each
--      distinct option is linked to inventory once, in
--      recipe_option_ingredients, and every recipe using "Lime" picks it up.
--        syrup  links are per pump        (x the recipe's pumps, default 2)
--        packet links are per full packet (x 1, 1/2 or 1/4, default 1/2)
--        every other option is per drink
--   2. Legacy recipe_ingredients rows, which already point at inventory --
--      except flavor-syrup rows on a recipe that has moved to recipes.syrups,
--      which the recipe form already treats as superseded.
--   3. The menu item's own "always uses" list (menu_item_ingredients). Coffee
--      and food have no recipe, so "a cookie uses 1 cookie" and "a latte uses
--      a hot cup and 8 oz of milk" live here.
--   4. Each add-on picked (modifier_option_ingredients).
--
-- menu_item_usage() is the one definition of that sum. The admin Usage Setup
-- screen previews it and phase 2's deduction will call it, so what the preview
-- shows is exactly what will come off the shelf.
--
-- Safe to run more than once.

-- ── Inventory: recipe units per counted unit ─────────────────────────────────
-- Recipes measure in pumps and ounces; students count bottles. This is the
-- bridge: a bottle of syrup = 32 pumps. (pack_size is different -- it is
-- recipe units per *purchase*, e.g. a 4-pack of bottles, and is set by receipts.)
alter table public.inventory
  add column if not exists base_units_per_unit numeric;

comment on column public.inventory.base_units_per_unit is
  'Recipe units (base_unit) in one counted unit (unit): a bottle of syrup = 32 pumps.';

-- Where both units name the same thing ("each"/"each", "cup"/"cups") the
-- answer is 1, and nobody should have to type it.
update public.inventory
set base_units_per_unit = 1
where base_units_per_unit is null
  and nullif(btrim(base_unit), '') is not null
  and regexp_replace(lower(btrim(base_unit)), 's$', '')
    = regexp_replace(lower(btrim(unit)), 's$', '');

-- ── Menu items: explicit recipe link ─────────────────────────────────────────
-- Menu items still match their recipe by name. This only overrides that, for
-- the item whose Square name differs from its recipe's.
alter table public.menu_items
  add column if not exists recipe_id uuid references public.recipes(id) on delete set null;

create index if not exists menu_items_recipe_id_idx on public.menu_items (recipe_id);

comment on column public.menu_items.recipe_id is
  'Recipe this item is made from when the names differ. Null = match a recipe by name.';

-- ── Link tables ──────────────────────────────────────────────────────────────
create table if not exists public.recipe_option_ingredients (
  id           uuid primary key default gen_random_uuid(),
  option_type  text not null check (option_type in
                 ('cup', 'machine_drink', 'machine_flavor', 'pour', 'packet', 'syrup', 'boba', 'topping')),
  option_name  text not null,
  -- Recipes saved before the pickers can spell an option in any casing.
  option_key   text generated always as (lower(btrim(option_name))) stored,
  inventory_id uuid not null references public.inventory(id) on delete cascade,
  amount       numeric not null check (amount > 0),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  unique (option_type, option_key, inventory_id)
);

create table if not exists public.menu_item_ingredients (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  inventory_id uuid not null references public.inventory(id) on delete cascade,
  amount       numeric not null check (amount > 0),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  unique (menu_item_id, inventory_id)
);

create table if not exists public.modifier_option_ingredients (
  id                 uuid primary key default gen_random_uuid(),
  modifier_option_id uuid not null references public.modifier_options(id) on delete cascade,
  inventory_id       uuid not null references public.inventory(id) on delete cascade,
  amount             numeric not null check (amount > 0),
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  unique (modifier_option_id, inventory_id)
);

create index if not exists roi_inventory_id_idx on public.recipe_option_ingredients (inventory_id);
create index if not exists mii_inventory_id_idx on public.menu_item_ingredients (inventory_id);
create index if not exists moi_inventory_id_idx on public.modifier_option_ingredients (inventory_id);

-- ── "Uses no stock" ──────────────────────────────────────────────────────────
-- Some things genuinely use nothing worth counting ("Light ice", "Extra hot").
-- Marking them lets the setup checklist reach "done" instead of flagging them
-- forever. It only quiets the checklist -- anything linked is still counted.
-- sync-catalog never writes these columns, so a sync keeps them.
alter table public.menu_items
  add column if not exists uses_no_inventory boolean not null default false;
alter table public.modifier_options
  add column if not exists uses_no_inventory boolean not null default false;

create table if not exists public.recipe_option_no_inventory (
  id          uuid primary key default gen_random_uuid(),
  option_type text not null check (option_type in
                ('cup', 'machine_drink', 'machine_flavor', 'pour', 'packet', 'syrup', 'boba', 'topping')),
  option_name text not null,
  option_key  text generated always as (lower(btrim(option_name))) stored,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (option_type, option_key)
);

-- Inventory setup, so admin/manager write like the rest of inventory; anyone
-- signed in can read, like recipes.
do $$
declare
  t text;
begin
  foreach t in array array['recipe_option_ingredients', 'menu_item_ingredients',
                           'modifier_option_ingredients', 'recipe_option_no_inventory'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'staff_all_' || t, t);
    execute format(
      'create policy %I on public.%I for all using (public.is_owner_or_staff()) with check (public.is_owner_or_staff())',
      'staff_all_' || t, t);
    execute format('drop policy if exists %I on public.%I', 'auth_read_' || t, t);
    execute format(
      'create policy %I on public.%I for select using (auth.uid() is not null)',
      'auth_read_' || t, t);
  end loop;
end $$;

-- ── A recipe's build steps, as linkable options ──────────────────────────────
-- Reads the same text the Recipe Sheet renders. "Lime (3 pumps)" is option
-- Lime with multiplier 3; "Cherry Limeade (Full packet)" is multiplier 1.
create or replace function public.recipe_build_options(p_recipe_id uuid)
returns table (option_type text, option_name text, option_key text, multiplier numeric)
language sql
stable
security invoker
set search_path = public
as $$
  with r as (
    select * from public.recipes where id = p_recipe_id
  ),
  raw (t, val) as (
              select 'cup'::text,     r.cup_type                 from r
    union all select 'machine_drink', r.coffee_machine_selection from r
    union all select 'pour',          r.beverage_pour            from r
    union all select 'boba',          r.boba                     from r
    union all select 'machine_flavor', v from r, unnest(string_to_array(r.coffee_machine_flavor, ',')) v
    union all select 'syrup',          v from r, unnest(string_to_array(r.syrups, ','))                v
    union all select 'packet',         v from r, unnest(string_to_array(r.packet, ','))                v
    union all select 'topping',        v from r, unnest(string_to_array(r.toppings, ','))              v
  ),
  parsed as (
    select t,
           btrim(regexp_replace(btrim(val), '\s*\([^)]*\)$', '')) as nm,
           lower(btrim(substring(btrim(val) from '\(([^)]*)\)$')))  as note
    from raw
    where nullif(btrim(val), '') is not null
      and btrim(val) !~* '^(none|n/a|-{1,2})$'
  )
  select t, nm, lower(nm),
    case t
      when 'syrup'  then coalesce(substring(note from '([0-9]+(\.[0-9]+)?)')::numeric, 2)
      when 'packet' then case note when 'full packet' then 1 when 'quarter packet' then 0.25 else 0.5 end
      else 1
    end
  from parsed
  where nm <> '';
$$;

-- ── Which recipe each menu item is made from ─────────────────────────────────
-- The explicit link wins; otherwise a recipe with the same name.
create or replace view public.menu_item_recipe_links
with (security_invoker = true) as
select m.id                          as menu_item_id,
       coalesce(m.recipe_id, by_name.id) as recipe_id,
       (m.recipe_id is not null)     as linked_manually
from public.menu_items m
left join lateral (
  select r.id
  from public.recipes r
  where lower(btrim(r.name)) = lower(btrim(m.name))
  order by r.updated_at desc nulls last, r.created_at desc
  limit 1
) by_name on m.recipe_id is null;

-- ── What one sale uses ───────────────────────────────────────────────────────
-- Amounts are in each inventory item's base_unit, one row per contributing
-- link (sum by inventory_id for totals). p_modifier_ids are Square catalog ids
-- -- modifier_options.square_id -- which is what app carts, subscription slots
-- and Square register sales all carry.
create or replace function public.menu_item_usage(p_menu_item_id uuid, p_modifier_ids text[] default '{}')
returns table (inventory_id uuid, amount numeric, source text, detail text)
language sql
stable
security invoker
set search_path = public
as $$
  with link as (
    select l.recipe_id
    from public.menu_item_recipe_links l
    where l.menu_item_id = p_menu_item_id and l.recipe_id is not null
  )
  -- 1. Recipe build steps
  select roi.inventory_id, roi.amount * o.multiplier, 'recipe'::text, o.option_type || ': ' || o.option_name
  from link
  cross join lateral public.recipe_build_options(link.recipe_id) o
  join public.recipe_option_ingredients roi
    on roi.option_type = o.option_type and roi.option_key = o.option_key

  union all
  -- 2. Legacy ingredient rows
  select ri.inventory_id, ri.amount, 'recipe', 'ingredient'
  from link
  join public.recipes r            on r.id = link.recipe_id
  join public.recipe_ingredients ri on ri.recipe_id = r.id
  join public.inventory i          on i.id = ri.inventory_id
  where not (
    nullif(btrim(r.syrups), '') is not null
    and i.category = 'flavors'
    and lower(btrim(coalesce(i.unit, ''))) <> 'packet'
  )

  union all
  -- 3. The item's own "always uses" list
  select mii.inventory_id, mii.amount, 'item', null
  from public.menu_item_ingredients mii
  where mii.menu_item_id = p_menu_item_id

  union all
  -- 4. Add-ons
  select moi.inventory_id, moi.amount, 'add-on', mo.name
  from public.modifier_options mo
  join public.modifier_option_ingredients moi on moi.modifier_option_id = mo.id
  where mo.square_id = any (coalesce(p_modifier_ids, '{}'::text[]));
$$;

-- ── Views for the Usage Setup screen ─────────────────────────────────────────
-- Every build option on every recipe, so the screen can list what still needs
-- linking without re-parsing recipe text in the browser.
create or replace view public.recipe_build_option_rows
with (security_invoker = true) as
select r.id as recipe_id, o.option_type, o.option_name, o.option_key, o.multiplier
from public.recipes r
cross join lateral public.recipe_build_options(r.id) o;

-- One plain sale of each menu item (no add-ons).
create or replace view public.menu_item_usage_preview
with (security_invoker = true) as
select m.id as menu_item_id, u.inventory_id, u.amount, u.source, u.detail
from public.menu_items m
cross join lateral public.menu_item_usage(m.id) u;

grant select on public.menu_item_recipe_links   to authenticated;
grant select on public.recipe_build_option_rows to authenticated;
grant select on public.menu_item_usage_preview  to authenticated;
grant execute on function public.recipe_build_options(uuid)     to authenticated;
grant execute on function public.menu_item_usage(uuid, text[])  to authenticated;

-- Check it:
--   select m.name, i.name as uses, u.amount, i.base_unit, u.detail
--   from public.menu_item_usage_preview u
--   join public.menu_items m on m.id = u.menu_item_id
--   join public.inventory  i on i.id = u.inventory_id
--   order by m.name;
