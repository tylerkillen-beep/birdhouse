-- Let every approved staff member read hidden menu items, not just admins and
-- managers, so students can attach a recipe to a drink before it goes on the
-- menu. The Recipes tab already lists hidden items; this policy is what lets
-- them come back from the database for a student.
--
-- Read access only. Editing menu items stays admin/manager-only
-- (menu_items_staff_write_policy), and customers still see available items
-- only (menu_items_public_read_available_policy). Policies combine with OR,
-- so this adds to those rather than replacing them.
--
-- is_approved_staff() comes from 20260903_open_recipe_writes_to_all_staff.sql.

drop policy if exists menu_items_approved_staff_read_policy on public.menu_items;
create policy menu_items_approved_staff_read_policy
  on public.menu_items for select
  using (public.is_approved_staff());
