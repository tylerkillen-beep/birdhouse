-- Ingredient costing from receipts
--
-- Goal: uploading a receipt updates the cost of every drink that uses the items
-- on it. The missing link was unit conversion -- a receipt prices a 12-pack,
-- while a recipe consumes ounces -- so this adds the pack-size data needed to
-- get from one to the other, plus a place to store the resulting unit cost.
--
--   receipt line ($6.48 per 12-pack)
--     -> pack_count 12 x unit_size 12 fl oz = pack_size 144 oz
--     -> inventory.cost_per_base_unit_cents = 648 / 144 = 4.5 cents/oz
--     -> recipe using 8 oz of it costs 36 cents
--
-- Costing method is "latest receipt wins": the most recent purchase price
-- replaces the stored cost. purchase_order_items keeps the full history, so a
-- different method can be computed later without losing data.
--
-- Safe to run more than once -- every statement is idempotent.

-- ── Inventory: base unit, pack size, and current cost ────────────────────────
alter table if exists public.inventory
  -- The unit recipes measure in ('oz', 'each', 'pump'). Distinct from the
  -- existing free-text `unit`, which describes how the item is stocked.
  add column if not exists base_unit                text,
  -- Base units in one purchased unit: a 12-pack of 12 fl oz cans = 144.
  add column if not exists pack_size                numeric,
  -- Fractional cents matter here: 648 / 144 = 4.5 cents per ounce.
  add column if not exists cost_per_base_unit_cents numeric(12,4),
  add column if not exists cost_updated_at          timestamptz;

comment on column public.inventory.pack_size is
  'Base units per purchased unit. 12-pack of 12 fl oz cans = 144.';
comment on column public.inventory.cost_per_base_unit_cents is
  'Cost of one base_unit, in cents. Set from the most recent receipt.';

-- ── Purchase order items: the size data a receipt actually carries ───────────
alter table if exists public.purchase_order_items
  add column if not exists pack_count    numeric,  -- 12 cans
  add column if not exists unit_size     numeric,  -- of 12 ...
  add column if not exists unit_size_uom text;     -- ... fl oz

-- ── Remembered receipt-line -> inventory mappings ────────────────────────────
-- The receipt review screen already fuzzy-matches "Sprite Zero 12pk Cans" to
-- the Sprite inventory row. This makes a confirmed match stick, so the same
-- vendor wording maps itself on every future receipt.
create table if not exists public.inventory_aliases (
  id            uuid primary key default gen_random_uuid(),
  inventory_id  uuid not null references public.inventory(id) on delete cascade,
  raw_name_norm text not null unique,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

create index if not exists inventory_aliases_inventory_id_idx
  on public.inventory_aliases (inventory_id);

alter table public.inventory_aliases enable row level security;

drop policy if exists "staff_all_inventory_aliases" on public.inventory_aliases;
create policy "staff_all_inventory_aliases"
  on public.inventory_aliases for all
  using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

-- ── Recipe cost rollup ───────────────────────────────────────────────────────
-- A view rather than a stored column so it can never go stale: change a cost or
-- an ingredient amount and every drink's cost is correct on the next read.
--
-- cost_cents is a partial total when ingredients_missing_cost > 0 -- sum()
-- skips nulls, so a recipe with an uncosted ingredient still returns a number.
-- Callers should treat any non-zero missing count as "incomplete", not "cheap".
create or replace view public.recipe_costs
with (security_invoker = true) as
select
  r.id   as recipe_id,
  r.name as recipe_name,
  coalesce(sum(ri.amount * i.cost_per_base_unit_cents), 0)::numeric(12,4) as cost_cents,
  count(ri.id) as ingredient_count,
  count(*) filter (
    where ri.id is not null and i.cost_per_base_unit_cents is null
  ) as ingredients_missing_cost,
  -- A recipe measured in oz against an inventory item based in 'each' would
  -- multiply out to nonsense, so surface the mismatch rather than hide it.
  count(*) filter (
    where ri.id is not null
      and nullif(trim(ri.unit), '') is not null
      and nullif(trim(i.base_unit), '') is not null
      and lower(trim(ri.unit)) <> lower(trim(i.base_unit))
  ) as ingredients_unit_mismatch,
  max(i.cost_updated_at) as cost_last_updated_at
from public.recipes r
left join public.recipe_ingredients ri on ri.recipe_id = r.id
left join public.inventory i          on i.id = ri.inventory_id
group by r.id, r.name;

grant select on public.recipe_costs to authenticated;
