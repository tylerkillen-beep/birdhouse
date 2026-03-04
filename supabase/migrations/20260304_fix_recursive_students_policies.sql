-- Fix recursive RLS failures caused by self-referential policies on public.students.
-- This migration installs a SECURITY DEFINER helper and resets students policies
-- to non-recursive rules.

create or replace function public.is_owner_or_staff()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_role text;
begin
  if v_email = 'tylerkillen@nixaschools.net' then
    return true;
  end if;

  if v_uid is null then
    return false;
  end if;

  select s.role into v_role
  from public.students s
  where s.id = v_uid
  limit 1;

  return v_role in ('admin', 'manager');
end;
$$;

revoke all on function public.is_owner_or_staff() from public;
grant execute on function public.is_owner_or_staff() to anon, authenticated;

-- Drop all existing policies on students to remove recursive definitions.
do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'students'
  loop
    execute format('drop policy if exists %I on public.students', pol.policyname);
  end loop;
end $$;

-- Recreate safe, non-recursive policies.
create policy students_select_policy
on public.students
for select
using (
  auth.uid() = id
  or public.is_owner_or_staff()
);

create policy students_insert_policy
on public.students
for insert
with check (
  auth.uid() = id
  or public.is_owner_or_staff()
);

create policy students_update_policy
on public.students
for update
using (
  auth.uid() = id
  or public.is_owner_or_staff()
)
with check (
  auth.uid() = id
  or public.is_owner_or_staff()
);

create policy students_delete_policy
on public.students
for delete
using (public.is_owner_or_staff());
