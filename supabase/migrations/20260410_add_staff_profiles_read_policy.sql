-- Allow staff (admin / manager / student role) to read all profiles.
-- This lets the order queue fetch profile locations so it can correctly
-- display Mathews vs Birdhouse orders even for legacy rows that predate
-- the customer_location column.

create policy profiles_staff_select_policy
on public.profiles
for select
using (
  auth.uid() = id
  or public.is_owner_or_staff()
  or exists (
    select 1
    from public.students s
    where s.id = auth.uid()
      and s.role = 'student'
  )
);
