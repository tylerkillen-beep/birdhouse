-- Let admins mark a flavor (modifier option) out of stock without deleting it.
-- The order and subscribe pages hide options with available = false.
--
-- sync-catalog copies each option's name, price, and sort order from Square
-- but never writes this column, so a sync neither switches an out-of-stock
-- flavor back on nor switches a new one off (new rows default to available).
alter table public.modifier_options
  add column if not exists available boolean not null default true;
