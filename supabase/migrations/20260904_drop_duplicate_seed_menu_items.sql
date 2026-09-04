-- Remove the three hand-seeded menu items the Square catalog now covers.
--
-- These predate the Square integration -- they are the only rows left with
-- square_item_id null -- and each duplicates a synced item that carries a
-- fuller description:
--
--   Latte      "Cookie latte with chocolate syrup"  vs the synced Latte
--   Mocha      "Chocolate and sweet"                vs the synced Mocha
--   Cappuccino "Espresso with foam"                 (no synced twin; retired)
--
-- Because they have no square_item_id, sync-catalog never touches them and
-- never re-creates them, so this is a one-way removal.
--
-- Heads up: reviews.menu_item_id is ON DELETE CASCADE, and the legacy Latte
-- carries one 3-star review. That review goes with it.
--
-- Recipes match menu items by name rather than id, so the Latte and Mocha
-- recipes keep working against the synced rows.
--
-- Safe to run more than once.

-- Preview before committing to it:
--   select id, name, description, available, square_item_id
--   from public.menu_items
--   where square_item_id is null;

delete from public.menu_items
where square_item_id is null
  and (name, description) in (
    ('Latte',      'Cookie latte with chocolate syrup'),
    ('Mocha',      'Chocolate and sweet'),
    ('Cappuccino', 'Espresso with foam')
  );
