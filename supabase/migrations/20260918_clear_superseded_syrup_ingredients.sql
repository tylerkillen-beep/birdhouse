-- Clear legacy flavor-syrup ingredient rows that recipes.syrups has replaced.
--
-- Syrups moved from recipe_ingredients onto recipes.syrups (20260904). The
-- recipe form reads the old rows into its syrup checklist, but saving never
-- removed them, so an edited recipe kept showing its old syrups on the admin
-- Recipes card and in Item Lookup -- and recipe_costs kept costing them --
-- next to the new ones. menu_item_usage() already ignores these rows; this
-- drops them using the same rule. The admin form now deletes them on save too.
--
-- Safe to run more than once.

delete from public.recipe_ingredients ri
using public.recipes r, public.inventory i
where r.id = ri.recipe_id
  and i.id = ri.inventory_id
  and nullif(btrim(r.syrups), '') is not null
  and i.category = 'flavors'
  and lower(btrim(coalesce(i.unit, ''))) <> 'packet';
