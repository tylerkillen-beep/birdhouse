-- Menu Board + Recipe Sheet (Phase 1)
--
-- Adds:
--   1. menu_items.image_url        — photo for the Menu Board's specials callouts.
--   2. recipes build-spec columns  — the structured drink-build fields staff need
--      on the Recipe Sheet (cup / ice / machine selection / packet / pour / toppings).
--      Ingredients that are actually inventory-consumed (syrups, boba, etc.) keep
--      using the existing recipe_ingredients table so the same entry can later
--      feed cost calculation — these new columns are just for the non-inventory
--      build steps that don't have a natural home there.
--   3. A public "menu-images" Storage bucket + policies so staff can upload
--      photos and the Menu Board (and everyone else) can view them.
--
-- Safe to run more than once — every statement is idempotent.

alter table if exists public.menu_items
  add column if not exists image_url text;

alter table if exists public.recipes
  add column if not exists cup_type                text,
  add column if not exists ice_amount               text,
  add column if not exists coffee_machine_selection text,
  add column if not exists packet                   text,
  add column if not exists beverage_pour             text,
  add column if not exists toppings                 text;

-- Storage bucket for menu item photos. Public so the Menu Board page (no login)
-- can display them directly by URL.
insert into storage.buckets (id, name, public)
values ('menu-images', 'menu-images', true)
on conflict (id) do update set public = true;

-- Anyone can view images in this bucket (needed for the public Menu Board page).
drop policy if exists "menu_images_public_read" on storage.objects;
create policy "menu_images_public_read"
  on storage.objects for select
  using (bucket_id = 'menu-images');

-- Only staff (admin/manager, via the existing is_owner_or_staff() helper) can
-- upload, replace, or remove menu item photos.
drop policy if exists "menu_images_staff_write" on storage.objects;
create policy "menu_images_staff_write"
  on storage.objects for insert
  with check (bucket_id = 'menu-images' and public.is_owner_or_staff());

drop policy if exists "menu_images_staff_update" on storage.objects;
create policy "menu_images_staff_update"
  on storage.objects for update
  using (bucket_id = 'menu-images' and public.is_owner_or_staff())
  with check (bucket_id = 'menu-images' and public.is_owner_or_staff());

drop policy if exists "menu_images_staff_delete" on storage.objects;
create policy "menu_images_staff_delete"
  on storage.objects for delete
  using (bucket_id = 'menu-images' and public.is_owner_or_staff());

-- Note: if your Supabase project has "Storage" RLS managed outside SQL access
-- (some hosted plans restrict writes to storage.objects from the SQL editor),
-- create the "menu-images" bucket manually in Dashboard → Storage instead, mark
-- it Public, then skip straight to the two "staff_write"/"staff_update"/
-- "staff_delete" policies above (the public-read policy can also be set via the
-- bucket's "Public bucket" toggle instead of the SQL policy).
