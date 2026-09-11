-- Website-only sale on a menu item: a whole-number percent off that the order
-- page and the public menu apply. Square never sees it, so the register and
-- the in-store Menu Board keep charging and showing the full price.
--
-- sync-catalog only writes the columns Square owns, so a sync never ends a
-- running sale. Capped below 100 because process-payment refuses a
-- zero-dollar order, so a fully free drink could not be checked out.
alter table public.menu_items
  add column if not exists website_discount_pct integer not null default 0
  constraint menu_items_website_discount_pct_range
    check (website_discount_pct between 0 and 99);
