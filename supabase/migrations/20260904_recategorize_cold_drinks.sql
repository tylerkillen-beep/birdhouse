-- Move the non-coffee drinks out of the Coffee category.
--
-- "Birdie Brews" on the staff Recipe Sheet -- and "Coffee" on the public menu,
-- the Menu Board and the customer order page -- is meant to be the coffee menu:
-- espresso-machine drinks only. These six are boba and fruit drinks that ended
-- up tagged 'Coffee' because the 2026-08-28 Square sync reset every item to
-- that default, and restore_menu_categories_20260828.sql only knew about the
-- items in that day's snapshot.
--
-- Matcha, Hot Chocolate and Chai Latte deliberately stay in Coffee: they're
-- built on the machine alongside the lattes, so that's where staff look.
--
-- This sticks -- sync-catalog now seeds category on insert only and never
-- overwrites it on update (supabase/functions/sync-catalog/index.ts), which was
-- the bug that caused the mass reset in the first place.
--
-- Safe to run more than once.

update public.menu_items
set category = 'Soda & Tea'
where name in (
  'Go With The Flow',
  'Jeff''s Boba Splash',
  'Mermaid Splash',
  'Pink Lemon Pearl',
  'Red Rush',
  'Strawberry Shortcake'
)
and category is distinct from 'Soda & Tea';

-- Check the result -- every row below should now read 'Soda & Tea':
--   select name, category from public.menu_items
--   where name in ('Go With The Flow', 'Jeff''s Boba Splash', 'Mermaid Splash',
--                  'Pink Lemon Pearl', 'Red Rush', 'Strawberry Shortcake')
--   order by name;
