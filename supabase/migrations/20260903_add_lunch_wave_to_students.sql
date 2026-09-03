-- 6th Hour lunch rotation
--
-- 6th Hour is split into three waves. Each 6th-Hour student picks one wave
-- to take lunch during; they work whatever position the daily schedule
-- already assigns them for the other two waves. The wave only changes
-- whether a student is on lunch or on the floor for that stretch -- it
-- doesn't change what position they hold, so no changes are needed to
-- daily_positions.
--
-- Safe to run more than once.

alter table public.students
  add column if not exists lunch_wave smallint;

alter table public.students
  drop constraint if exists students_lunch_wave_check;
alter table public.students
  add constraint students_lunch_wave_check check (lunch_wave is null or lunch_wave in (1, 2, 3));

comment on column public.students.lunch_wave is
  '6th Hour lunch rotation wave: 1, 2, or 3. Null = not set (or a 1st Hour student, where lunch rotation does not apply).';
