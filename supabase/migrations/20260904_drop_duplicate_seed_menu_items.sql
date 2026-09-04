-- Let menu items be deleted again, then remove three the Square catalog covers.
--
-- Deleting a menu item failed with a foreign key violation -- in the admin UI
-- and in SQL alike -- because several tables reference menu_items(id) with no
-- delete rule. They surfaced one at a time (menu_submissions first, then
-- subscription_drink_slots), so step 1 stops guessing and walks every foreign
-- key pointing at menu_items instead of naming them.
--
-- RUN AS TWO SEPARATE STATEMENTS. The Supabase SQL editor runs a script in one
-- transaction, so if step 2 hits a constraint step 1 hasn't handled, the whole
-- thing rolls back and step 1's report is lost with it.

-- ── Step 1: repoint what's referenced, then give the constraints a delete rule
-- Two things per referencing column:
--   a) Move live references off the duplicate Latte/Mocha onto the surviving
--      Square rows. A customer's subscription slot keeps pointing at a real
--      drink instead of rendering "Unknown drink", and a student's review stays
--      attached to the drink it was written about. Cappuccino has no survivor,
--      so its references are left to clear.
--   b) Convert a blocking rule (no action / restrict) to ON DELETE SET NULL,
--      which never removes a row -- it only clears the link. A NOT NULL column
--      can't take that, so those are reported rather than forced: deciding
--      whether such a row should die with the menu item is not this migration's
--      call to make.
do $$
declare
  r        record;
  k        text;
  n        integer;
  blocked  text[] := '{}';
  -- doomed id -> surviving id
  remap constant jsonb := jsonb_build_object(
    '0bd0ce96-e2bc-4b51-9df6-5db791744a87', 'dd24a4a4-12c7-4c0a-b2d9-c98e18520858', -- Latte
    'b0e1c340-fdf5-4eba-a154-9bf94e538339', '83bcdeab-4ff6-4bfa-998f-f4a1491812d4'  -- Mocha
  );
begin
  for r in
    select c.conname, t.relname as tbl, a.attname as col,
           a.attnotnull as notnull, c.confdeltype
    from pg_constraint c
    join pg_class     t on t.oid = c.conrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.menu_items'::regclass
      and c.contype = 'f'
      and array_length(c.conkey, 1) = 1
  loop
    for k in select jsonb_object_keys(remap) loop
      begin
        execute format('update public.%I set %I = %L where %I = %L',
                       r.tbl, r.col, remap ->> k, r.col, k);
        get diagnostics n = row_count;
        if n > 0 then
          raise notice 'repointed % row(s) in %.%', n, r.tbl, r.col;
        end if;
      exception when unique_violation then
        raise notice 'skipped repoint in %.% - would duplicate an existing row', r.tbl, r.col;
      end;
    end loop;

    if r.confdeltype in ('a', 'r') then
      if r.notnull then
        blocked := blocked || format('%s.%s', r.tbl, r.col);
      else
        execute format('alter table public.%I drop constraint %I', r.tbl, r.conname);
        execute format('alter table public.%I add constraint %I foreign key (%I) '
                       'references public.menu_items(id) on delete set null',
                       r.tbl, r.conname, r.col);
        raise notice 'on delete set null: %.% (%)', r.tbl, r.col, r.conname;
      end if;
    end if;
  end loop;

  if array_length(blocked, 1) > 0 then
    raise notice 'STILL BLOCKING (NOT NULL, needs a decision): %',
                 array_to_string(blocked, ', ');
  end if;
end $$;

-- What every foreign key on menu_items now does. Anything still reading
-- "BLOCKS" will stop step 2.
select t.relname as referencing_table, a.attname as column_name,
       case c.confdeltype when 'a' then 'no action (BLOCKS)'
                          when 'r' then 'restrict (BLOCKS)'
                          when 'c' then 'cascade'
                          when 'n' then 'set null'
                          when 'd' then 'set default' end as on_delete
from pg_constraint c
join pg_class     t on t.oid = c.conrelid
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
where c.confrelid = 'public.menu_items'::regclass and c.contype = 'f'
order by 1;


-- ── Step 2: remove the duplicates ────────────────────────────────────────────
-- These predate the Square integration -- the only rows left with
-- square_item_id null -- and each duplicates a synced item with a fuller
-- description. Having no square_item_id, sync-catalog never touches or
-- re-creates them, so this is a one-way removal. Matched on id rather than
-- name so a text mismatch can't quietly match nothing and look like success.
delete from public.menu_items
where id in (
  '0bd0ce96-e2bc-4b51-9df6-5db791744a87',  -- Latte,      "Cookie latte with chocolate syrup"
  '9897debd-f505-4787-bf19-211a1f600808',  -- Cappuccino, "Espresso with foam"
  'b0e1c340-fdf5-4eba-a154-9bf94e538339'   -- Mocha,      "Chocolate and sweet"
);

-- Should return zero rows.
select id, name, description from public.menu_items where square_item_id is null;
