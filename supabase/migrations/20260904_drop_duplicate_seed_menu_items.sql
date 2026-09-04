-- Let menu items be deleted again, then remove three the Square catalog covers.
--
-- ── Why deleting was failing ─────────────────────────────────────────────────
-- menu_submissions.target_item_id references menu_items(id) with no delete
-- rule, so Postgres refuses to remove any item a student has ever submitted an
-- edit for:
--
--   ERROR 23503: update or delete on table "menu_items" violates foreign key
--   constraint "menu_submissions_target_item_id_fkey"
--
-- That is what the admin page's Delete button was reporting too. A submission
-- is a record of what a student proposed, so it should outlive the item it
-- pointed at -- ON DELETE SET NULL keeps the history and lets the item go.
-- (reviews.menu_item_id is already ON DELETE CASCADE and never blocked this.)
--
-- Note the knock-on: approving an "edit" submission whose target has since been
-- deleted now falls through to the "create a new item" branch in
-- approveMenuSubmission(), because target_item_id reads null. The admin list
-- labels those as "Edit (item deleted)" so nobody approves one by accident.
--
-- Safe to run more than once.

alter table public.menu_submissions
  drop constraint if exists menu_submissions_target_item_id_fkey;

alter table public.menu_submissions
  add constraint menu_submissions_target_item_id_fkey
  foreign key (target_item_id) references public.menu_items(id) on delete set null;

-- ── The three duplicates ─────────────────────────────────────────────────────
-- These predate the Square integration -- the only rows left with
-- square_item_id null -- and each duplicates a synced item with a fuller
-- description:
--
--   Latte      "Cookie latte with chocolate syrup"  vs the synced Latte
--   Mocha      "Chocolate and sweet"                vs the synced Mocha
--   Cappuccino "Espresso with foam"                 (no synced twin; retired)
--
-- Having no square_item_id, sync-catalog never touches or re-creates them, so
-- this is a one-way removal. The legacy Latte carries one 3-star review, and
-- reviews cascade -- that review goes with it. Recipes match menu items by name
-- rather than id, so the Latte and Mocha recipes keep working against the
-- synced rows.

delete from public.menu_items
where square_item_id is null
  and (name, description) in (
    ('Latte',      'Cookie latte with chocolate syrup'),
    ('Mocha',      'Chocolate and sweet'),
    ('Cappuccino', 'Espresso with foam')
  );

-- If a delete is ever blocked again, this lists every foreign key pointing at
-- menu_items and what each one does on delete ('a' = no action, 'r' = restrict,
-- 'c' = cascade, 'n' = set null):
--   select c.conname, c.confdeltype, t.relname as referencing_table
--   from pg_constraint c
--   join pg_class t on t.oid = c.conrelid
--   where c.confrelid = 'public.menu_items'::regclass and c.contype = 'f';
