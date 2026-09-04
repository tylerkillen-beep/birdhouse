-- Recipe build-spec fields become dropdowns / checklists.
--
-- Three values used to be squeezed into existing columns (or into
-- recipe_ingredients) and now get their own home on the recipe row:
--
--   coffee_machine_flavor -- the syrup the espresso machine adds (Vanilla,
--     Caramel, ...). coffee_machine_selection keeps the drink itself (Latte,
--     Mocha, ...), so the two are pickable independently.
--   syrups  -- pump syrups, comma separated, e.g. "Blue Raspberry, Lime
--     (3 pumps)". These were recipe_ingredients rows before; storing the
--     staff-facing name here keeps the Recipe Sheet readable and leaves a
--     clean key to hang cost tracking off later.
--   boba    -- single boba flavor. Previously shared recipes.toppings with
--     the toppings list, which made the two impossible to tell apart.
--
-- Nothing is dropped or rewritten: existing recipe_ingredients rows and any
-- boba value still sitting in recipes.toppings stay exactly where they are,
-- and the recipe form reads them as a fallback until a recipe is next saved.
--
-- Safe to run more than once.

alter table if exists public.recipes
  add column if not exists coffee_machine_flavor text,
  add column if not exists syrups                text,
  add column if not exists boba                  text;
