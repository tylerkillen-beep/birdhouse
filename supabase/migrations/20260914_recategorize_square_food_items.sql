-- Move every item in Square's "Food" category into the site's Food category,
-- so it lists under "Tasty Treats" on the Menu Board and with the food on the
-- public menu, order page and Recipe Sheet.
--
-- Protein Balls was tagged 'Coffee' because sync-catalog seeded new items from
-- Square's old category_id field, which newer items leave empty. The sync now
-- reads the categories list too (supabase/functions/sync-catalog/index.ts), so
-- food added in Square from here on arrives as Food.
--
-- Safe to run more than once.

update public.menu_items m
set category = 'Food'
where m.category is distinct from 'Food'
and exists (
  select 1 from public.square_categories c
  where c.name = 'Food' and c.square_id = any (m.square_category_ids)
);

-- Check the result -- every row below should read 'Food':
--   select m.name, m.category from public.menu_items m
--   join public.square_categories c on c.square_id = any (m.square_category_ids)
--   where c.name = 'Food' order by m.name;
