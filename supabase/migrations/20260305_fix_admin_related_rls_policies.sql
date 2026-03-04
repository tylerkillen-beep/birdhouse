-- Comprehensive RLS repair for admin-facing tables.
-- Addresses recursive-policy failures and restores sane access rules
-- for students, orders, menu_items, and menu_submissions.

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

alter table if exists public.students enable row level security;
alter table if exists public.orders enable row level security;
alter table if exists public.menu_items enable row level security;
alter table if exists public.menu_submissions enable row level security;

-- Utility block to drop existing policies by table.
do $$
declare
  t text;
  pol record;
begin
  foreach t in array array['students','orders','menu_items','menu_submissions'] loop
    for pol in
      select policyname
      from pg_policies
      where schemaname = 'public'
        and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $$;

-- students
create policy students_select_policy
on public.students
for select
using (auth.uid() = id or public.is_owner_or_staff());

create policy students_insert_policy
on public.students
for insert
with check (auth.uid() = id or public.is_owner_or_staff());

create policy students_update_policy
on public.students
for update
using (auth.uid() = id or public.is_owner_or_staff())
with check (auth.uid() = id or public.is_owner_or_staff());

create policy students_delete_policy
on public.students
for delete
using (public.is_owner_or_staff());

-- orders (admin/staff full access)
create policy orders_staff_all_policy
on public.orders
for all
using (public.is_owner_or_staff())
with check (public.is_owner_or_staff());

-- menu_items
create policy menu_items_public_read_available_policy
on public.menu_items
for select
using (coalesce(available, false) = true or public.is_owner_or_staff());

create policy menu_items_staff_write_policy
on public.menu_items
for all
using (public.is_owner_or_staff())
with check (public.is_owner_or_staff());

-- menu_submissions
create policy menu_submissions_student_insert_policy
on public.menu_submissions
for insert
with check (auth.uid() = student_id);

create policy menu_submissions_student_select_own_policy
on public.menu_submissions
for select
using (auth.uid() = student_id or public.is_owner_or_staff());

create policy menu_submissions_staff_update_policy
on public.menu_submissions
for update
using (public.is_owner_or_staff())
with check (public.is_owner_or_staff());

create policy menu_submissions_staff_delete_policy
on public.menu_submissions
for delete
using (public.is_owner_or_staff());
