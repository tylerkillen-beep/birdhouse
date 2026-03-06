-- Ensure menu_items has the columns required by the sync-catalog edge function.
-- Uses ADD COLUMN IF NOT EXISTS so this is safe to run on a table that already
-- has some or all of these columns.

alter table if exists public.menu_items
  add column if not exists square_item_id text,
  add column if not exists square_modifier_list_ids jsonb not null default '[]'::jsonb;

-- Unique index lets sync-catalog look up an existing row by its Square ID.
-- CREATE UNIQUE INDEX IF NOT EXISTS is idempotent.
create unique index if not exists menu_items_square_item_id_key
  on public.menu_items (square_item_id)
  where square_item_id is not null;
