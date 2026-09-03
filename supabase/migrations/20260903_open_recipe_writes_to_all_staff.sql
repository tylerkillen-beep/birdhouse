-- Let any approved staff member add/edit/delete recipes, not just admins and
-- managers. is_owner_or_staff() stays admin/manager-only everywhere else
-- (inventory writes, purchase orders) -- this only widens the two recipe
-- tables, via a new function so nothing else changes behavior.
--
-- "Approved staff" = a students row with role in ('student','manager','admin').
-- role is null while a signup is still pending approval, which correctly
-- keeps them out until someone approves them.

create or replace function public.is_approved_staff()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_role  text;
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

  return v_role in ('student', 'manager', 'admin');
end;
$$;

drop policy if exists "staff_all_recipes" on public.recipes;
create policy "staff_all_recipes"
  on public.recipes for all
  using (public.is_approved_staff()) with check (public.is_approved_staff());

drop policy if exists "staff_all_recipe_ingredients" on public.recipe_ingredients;
create policy "staff_all_recipe_ingredients"
  on public.recipe_ingredients for all
  using (public.is_approved_staff()) with check (public.is_approved_staff());
