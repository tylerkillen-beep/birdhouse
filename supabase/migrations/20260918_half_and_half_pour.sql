-- Half-and-half beverage pours.
--
-- The recipe form can now pick two pours for one drink, saved on
-- recipes.beverage_pour as "Sprite Zero (Half), Lemonade (Half)". A single
-- pour still saves as plain "Sprite Zero". This teaches the usage math to
-- split that text and count each half as 0.5 of a pour, so the drink uses half
-- a pour of each instead of a whole pour of both.
--
-- Same function as 20260911_inventory_usage_setup.sql, only the 'pour' line
-- and the multiplier case changed. Safe to re-run.

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
    union all select 'boba',          r.boba                     from r
    union all select 'pour',           v from r, unnest(string_to_array(r.beverage_pour, ','))         v
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
      when 'pour'   then case note when 'half' then 0.5 else 1 end
      else 1
    end
  from parsed
  where nm <> '';
$$;

-- Check it:
--   select r.name, o.option_name, o.multiplier
--   from public.recipes r
--   cross join lateral public.recipe_build_options(r.id) o
--   where o.option_type = 'pour'
--   order by r.name;
