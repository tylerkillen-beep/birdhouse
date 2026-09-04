-- Auto-create a flavor-syrup inventory item from the drink recipe form.
--
-- The recipe form's "Flavor Syrups" checkboxes save each pick as a real
-- recipe_ingredient, which needs a matching row in public.inventory. Direct
-- inventory writes are admin/manager-only (is_owner_or_staff), but recipe
-- writes are open to all approved staff (is_approved_staff) -- so a student
-- building a recipe couldn't create the syrup they picked, and it silently
-- dropped on save.
--
-- This SECURITY DEFINER function lets any approved staff member resolve a
-- syrup name to an inventory id, creating a minimal Flavors row (quantity 0,
-- unit "pump") if none exists yet. It only ever inserts one narrowly-shaped
-- row -- it can't edit existing inventory or read arbitrary rows back -- so
-- it doesn't otherwise widen inventory access.
--
-- Safe to run more than once.

create or replace function public.ensure_flavor_syrup(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid;
  v_name text := btrim(p_name);
  v_key  text := lower(btrim(p_name));
begin
  if not public.is_approved_staff() then
    raise exception 'not authorized';
  end if;
  if v_name = '' then
    raise exception 'syrup name is required';
  end if;

  -- Reuse an existing non-packet Flavors item, matched case-insensitively and
  -- tolerating a trailing "syrup" ("Lime" <-> "Lime Syrup"). Prefer an exact
  -- name match when there's more than one candidate.
  select id into v_id
  from public.inventory
  where category = 'flavors'
    and coalesce(lower(btrim(unit)), '') <> 'packet'
    and lower(name) in (v_key, v_key || ' syrup', regexp_replace(v_key, '\s*syrup$', ''))
  order by (lower(name) = v_key) desc
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  begin
    insert into public.inventory (name, category, quantity, unit, par_level, notes, created_by, updated_at)
    values (v_name, 'flavors', 0, 'pump', 0, 'Auto-added from a drink recipe', auth.uid(), now())
    returning id into v_id;
  exception when unique_violation then
    -- A same-named item already exists in another category; link to it rather
    -- than fail the recipe save.
    select id into v_id from public.inventory where lower(name) = v_key limit 1;
  end;

  return v_id;
end;
$$;

revoke all on function public.ensure_flavor_syrup(text) from public;
grant execute on function public.ensure_flavor_syrup(text) to authenticated;
