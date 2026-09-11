-- Let admins retire a menu item by hand. in_square already marks items
-- deleted from Square, but it belongs to sync-catalog, which sets it back to
-- true on every run for anything still in Square -- including register-only
-- items kept off the website. This column is the site's own: set by the
-- Retire / Restore buttons in admin and never written by the sync.
--
-- An item is retired when either flag says so. Retired items sit in the
-- collapsed "Retired" list in admin, stay off the student Menu Availability
-- tab, and their specials drop off the Recipe Sheet.
alter table public.menu_items
  add column if not exists retired boolean not null default false;
