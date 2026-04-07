-- Allow admins and managers to create, edit, and delete modifier lists and options.
-- Reads are already allowed for all users (modifier_lists_public_read /
-- modifier_options_public_read) via the 20260326_create_modifier_tables migration.

create policy modifier_lists_staff_write_policy
  on modifier_lists
  for all
  using (public.is_owner_or_staff())
  with check (public.is_owner_or_staff());

create policy modifier_options_staff_write_policy
  on modifier_options
  for all
  using (public.is_owner_or_staff())
  with check (public.is_owner_or_staff());
