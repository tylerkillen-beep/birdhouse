-- Whether a menu item still exists in Square. sync-catalog sets it true for
-- every item it sees, and false (alongside hiding the item) when one is gone:
-- deleted from Square or no longer offered at this location.
--
-- The Recipe Sheet uses it to split specials across the weekly rotation:
-- switched on = this week's, hidden but still in Square = next week's being
-- prepped, gone from Square = retired (left off the sheet; the recipe stays
-- saved in case the special comes back).
--
-- Run this BEFORE deploying the updated sync-catalog: the sync writes this
-- column on every item, and each write would fail without it. Every row
-- starts true, so click Sync in admin once afterwards to mark specials that
-- were already deleted from Square.
alter table public.menu_items
  add column if not exists in_square boolean not null default true;
