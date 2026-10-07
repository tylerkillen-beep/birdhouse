-- Usage standards: how much one pump, one pour or one scoop is, defined once.
--
-- A row says "this kind of build step uses this much":
--   option_type  as on recipe build steps: syrup (per pump), pour, topping, packet...
--   option_key   '' for the whole type ("one pump of any syrup = 0.25 oz"), or the
--                lower-cased step name for one specific thing ("creamer" = 1 oz)
--   amount, unit the amount, in the unit recipes measure that item in (oz, each...)
--
-- The Standards tab in Usage Setup pre-fills these when linking a step to an
-- inventory item, and can apply them to every link already made. A specific row
-- beats the whole-type row. Safe to run more than once.

create table if not exists public.usage_standards (
  id          uuid primary key default gen_random_uuid(),
  option_type text    not null,
  option_key  text    not null default '',
  amount      numeric not null check (amount > 0),
  unit        text    not null,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now(),
  unique (option_type, option_key)
);

alter table public.usage_standards enable row level security;
drop policy if exists staff_all_usage_standards on public.usage_standards;
create policy staff_all_usage_standards on public.usage_standards
  for all using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

grant select, insert, update, delete on public.usage_standards to authenticated;
grant all on public.usage_standards to service_role;

-- A pump is a quarter ounce unless told otherwise.
insert into public.usage_standards (option_type, option_key, amount, unit)
values ('syrup', '', 0.25, 'oz')
on conflict (option_type, option_key) do nothing;
