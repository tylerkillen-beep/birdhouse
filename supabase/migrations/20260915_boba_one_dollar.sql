-- Boba is $1.00. The current boba flavors in Flavor Shots already are, but
-- four older options were still 75¢: Peach, Blueberry and Strawberry in the
-- "Popping Boba" set, and the plain "Boba" option in "Coffee Modifiers".
-- The order page and process-payment charge from this table, so this is what
-- website customers pay.
--
-- sync-catalog copies prices from Square, so change these four in the Square
-- Dashboard to $1.00 too -- otherwise the next sync puts them back to 75¢,
-- and the register keeps charging 75¢ in the meantime.
--
-- Safe to run more than once.

update public.modifier_options
set price_cents = 100
where square_id in (
  'W2JRJYMYDHY4MTY5OSSKT3LW',  -- Popping Boba: Peach
  '5R6IYBASAFUAS3T2RJ7SVITU',  -- Popping Boba: Blueberry
  'RJYAFBIOISASSGQELXG3XAEE',  -- Popping Boba: Strawberry
  'EGIHLVE74PW6HYVEYFZNN62Y'   -- Coffee Modifiers: Boba
);

-- Check the result -- every row below should read 100:
--   select o.name, l.name as list, o.price_cents from public.modifier_options o
--   join public.modifier_lists l on l.id = o.modifier_list_id
--   where o.name ilike '%boba%' or l.name ilike '%boba%' order by l.name, o.name;
