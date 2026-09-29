-- Recipes per menu (Birdhouse / Mathews)
--
-- A drink can be on both menus under the same name and be built differently at
-- each. Until now recipes.name was unique and a menu item found its recipe by
-- name alone, so the two drinks had to share one recipe.
--
--   1. recipes.campus says which menu a recipe is for.
--   2. recipes.name stops being unique; (name, campus) is.
--   3. Existing recipes whose name only exists on the Mathews (Teacher Menu)
--      menu become Mathews recipes. Everything else stays Birdhouse.
--   4. menu_item_recipe_links matches by name AND menu. A manual link
--      (menu_items.recipe_id) still wins, as before.
--
-- Safe to run more than once.

alter table public.recipes
  add column if not exists campus text not null default 'birdhouse';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recipes_campus_check') then
    alter table public.recipes
      add constraint recipes_campus_check check (campus in ('birdhouse', 'mathews'));
  end if;
end $$;

-- Drop the old unique-on-name constraint, whatever it was called.
do $$
declare c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.recipes'::regclass
      and con.contype = 'u'
      and (select array_agg(att.attname::text) from pg_attribute att
           where att.attrelid = con.conrelid and att.attnum = any (con.conkey)) = array['name']
  loop
    execute format('alter table public.recipes drop constraint %I', c);
  end loop;
end $$;

create unique index if not exists recipes_name_campus_key on public.recipes (name, campus);

-- Which menu items are Mathews: the ones Square files under Teacher Menu
-- (the same rule as lib/mathews.js).
create or replace function public.is_mathews_menu_item(p_category_ids text[])
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.square_categories c
    where c.square_id = any (coalesce(p_category_ids, '{}'))
      and lower(btrim(c.name)) = 'teacher menu'
  );
$$;

grant execute on function public.is_mathews_menu_item(text[]) to anon, authenticated;

-- Backfill: a recipe named for a Mathews item and no Birdhouse item is Mathews.
update public.recipes r
set campus = 'mathews'
where r.campus = 'birdhouse'
  and exists (
    select 1 from public.menu_items m
    where lower(btrim(m.name)) = lower(btrim(r.name))
      and public.is_mathews_menu_item(m.square_category_ids)
  )
  and not exists (
    select 1 from public.menu_items m
    where lower(btrim(m.name)) = lower(btrim(r.name))
      and not public.is_mathews_menu_item(m.square_category_ids)
  );

-- Same view as before (explicit link wins, otherwise a recipe with the same
-- name), now also requiring the recipe to be for the item's own menu.
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
    and r.campus = case when public.is_mathews_menu_item(m.square_category_ids)
                        then 'mathews' else 'birdhouse' end
  order by r.updated_at desc nulls last, r.created_at desc
  limit 1
) by_name on m.recipe_id is null;
