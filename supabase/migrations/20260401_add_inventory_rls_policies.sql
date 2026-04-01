-- Enable RLS and add staff access policies for inventory tables.
-- Managers and admins were blocked from saving inventory edits because
-- neither inventory nor inventory_log had any RLS policies defined.

alter table if exists public.inventory enable row level security;
alter table if exists public.inventory_log enable row level security;

-- Drop any pre-existing policies on these tables before recreating them.
do $$
declare
  t text;
  pol record;
begin
  foreach t in array array['inventory','inventory_log'] loop
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

-- inventory: staff (admin + manager) have full access; all authenticated users can read.
create policy inventory_public_read_policy
on public.inventory
for select
using (auth.uid() is not null);

create policy inventory_staff_write_policy
on public.inventory
for all
using (public.is_owner_or_staff())
with check (public.is_owner_or_staff());

-- inventory_log: staff can insert audit entries and read the full log.
create policy inventory_log_staff_insert_policy
on public.inventory_log
for insert
with check (public.is_owner_or_staff());

create policy inventory_log_staff_select_policy
on public.inventory_log
for select
using (public.is_owner_or_staff());
