-- 6th Hour positions become per lunch wave.
--
-- 20260903_add_lunch_wave_to_students.sql assumed a student holds one position
-- for the whole day and the wave only decides whether they're on the floor or
-- at lunch. That can't staff the floor properly, because a different third of
-- the team is away in each wave. Concretely, for a 7-student team wanting two
-- cashiers and two baristas working at all times:
--
--   Lunch 1 free: Matthew, Caroline, Makenzie, Michael
--   Lunch 2 free: Avery, Kihanna, Makenzie, Michael, Molly
--   Lunch 3 free: Matthew, Avery, Caroline, Kihanna, Molly
--
-- Make Makenzie and Michael the Lunch 1 baristas and Matthew and Caroline are
-- its cashiers. Lunch 2 then already has both baristas, so Avery/Kihanna/Molly
-- must be its two cashiers plus a deliverer -- but Lunch 3 already has Matthew
-- and Caroline on register, so those same three must be its two baristas plus a
-- deliverer. No single per-day assignment satisfies both.
--
-- So a position is now keyed by wave as well as student and date:
--   lunch_wave 0 -- the whole shift. 1st Hour teams and Mathews have no wave
--                   rotation, so their rows stay one-per-day exactly as before.
--   lunch_wave 1/2/3 -- a 6th Hour Birdhouse position for that stretch only.
--
-- Existing rows become wave 0, which is what they already meant.
--
-- Safe to run more than once.

alter table public.daily_positions
  add column if not exists lunch_wave smallint not null default 0;

alter table public.daily_positions
  drop constraint if exists daily_positions_lunch_wave_check;
alter table public.daily_positions
  add constraint daily_positions_lunch_wave_check
  check (lunch_wave between 0 and 3);

-- Widen the uniqueness key to include the wave. The old two-column key is found
-- by shape rather than by name, since it may have been created as either a
-- constraint or a bare unique index and the name isn't recorded in this repo.
-- attname is type "name", so every comparison casts to text explicitly --
-- there is no name[] = text[] operator.
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.daily_positions'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by a.attname::text)
        from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      ) = array['shift_date','student_id']::text[]
  loop
    execute format('alter table public.daily_positions drop constraint %I', r.conname);
    raise notice 'dropped old unique constraint %', r.conname;
  end loop;

  -- A unique constraint owns its index, so anything left here is a bare index.
  for r in
    select i.relname
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'public.daily_positions'::regclass
      and x.indisunique
      and not x.indisprimary
      and (
        select array_agg(a.attname::text order by a.attname::text)
        from pg_attribute a
        where a.attrelid = x.indrelid
          and a.attnum = any(string_to_array(x.indkey::text, ' ')::smallint[])
      ) = array['shift_date','student_id']::text[]
  loop
    execute format('drop index public.%I', r.relname);
    raise notice 'dropped old unique index %', r.relname;
  end loop;
end $$;

alter table public.daily_positions
  drop constraint if exists daily_positions_student_date_wave_key;
alter table public.daily_positions
  add constraint daily_positions_student_date_wave_key
  unique (student_id, shift_date, lunch_wave);

comment on column public.daily_positions.lunch_wave is
  '0 = the whole shift (1st Hour, Mathews). 1/2/3 = a 6th Hour Birdhouse position for that lunch wave only, since who is on the floor changes each wave.';
