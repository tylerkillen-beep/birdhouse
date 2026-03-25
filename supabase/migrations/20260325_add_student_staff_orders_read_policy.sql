-- Allow student staff (role = 'student') to read all orders.
-- Previously, is_owner_or_staff() only granted access to 'admin' and 'manager'
-- roles, so students accessing the order queue received no data.
-- This adds a read-only SELECT policy for students without giving them write access.

create policy orders_student_staff_select_policy
on public.orders
for select
using (
  exists (
    select 1
    from public.students s
    where s.id = auth.uid()
      and s.role = 'student'
  )
);
