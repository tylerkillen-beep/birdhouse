-- Limit each subscription plan to drinks from chosen Square categories.
--
-- Plans are tiered by what a subscriber may pick: the lowest tier might only
-- offer the Birdhouse Product Line. Tiers are defined against Square's own
-- categories, because that is where the menu is organized.
--
-- menu_items.category cannot be used for this. It is a site-owned display
-- label (Coffee, Soda & Tea, ...) that sync-catalog seeds on insert and never
-- updates, so it drifts from Square by design. Square's categories are kept
-- separately here and refreshed on every sync.
--
-- Run BEFORE deploying the updated sync-catalog and save-card: both read or
-- write these columns and fail against a database that lacks them.
--
-- Safe to run more than once.

-- ── Square's categories ────────────────────────────────────────────────────
-- Written only by sync-catalog, which runs as the service role and bypasses
-- RLS, so there is no write policy. Everyone may read: the subscribe page
-- shows category names on the plan cards.
create table if not exists public.square_categories (
  square_id  text primary key,
  name       text not null,
  updated_at timestamptz not null default now()
);

alter table public.square_categories enable row level security;

drop policy if exists square_categories_public_read on public.square_categories;
create policy square_categories_public_read
on public.square_categories
for select
using (true);

-- ── Which categories each item is in ───────────────────────────────────────
-- Square-owned, overwritten on every sync. Includes parent categories, so a
-- plan limited to a parent also covers the items in its subcategories.
alter table public.menu_items
  add column if not exists square_category_ids text[] not null default '{}';

-- ── Which categories each plan offers ──────────────────────────────────────
-- Empty means every drink on the menu, which is how plans behaved before this.
alter table public.subscription_plans
  add column if not exists allowed_square_category_ids text[] not null default '{}';

-- ── Verify, after running Sync from Square ─────────────────────────────────
--   select c.name, count(m.id) as available_items
--   from public.square_categories c
--   left join public.menu_items m
--     on c.square_id = any (m.square_category_ids) and m.available
--   group by c.name
--   order by c.name;
