-- Purchase orders: tracks receipts uploaded from Amazon / Walmart
create table if not exists public.purchase_orders (
  id               uuid primary key default gen_random_uuid(),
  vendor           text not null check (vendor in ('amazon','walmart','other')),
  order_number     text,
  order_date       date,
  expected_arrival date,
  total_cents      integer,
  status           text not null default 'pending' check (status in ('pending','received','partial')),
  notes            text,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  received_at      timestamptz
);

-- Line items linked to a purchase order and optionally to an inventory item
create table if not exists public.purchase_order_items (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references public.purchase_orders(id) on delete cascade,
  raw_name            text not null,
  inventory_id        uuid references public.inventory(id) on delete set null,
  quantity            numeric not null default 1,
  unit_cost_cents     integer,
  received_quantity   numeric,
  created_at          timestamptz not null default now()
);

-- Recipes: one per menu item (name must match menu item name for auto-matching)
create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  active      boolean not null default true,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Recipe ingredients: amount of each inventory item consumed per serving/unit
create table if not exists public.recipe_ingredients (
  id           uuid primary key default gen_random_uuid(),
  recipe_id    uuid not null references public.recipes(id) on delete cascade,
  inventory_id uuid not null references public.inventory(id) on delete cascade,
  amount       numeric not null,
  unit         text,
  created_at   timestamptz not null default now(),
  unique (recipe_id, inventory_id)
);

-- RLS
alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.recipes              enable row level security;
alter table public.recipe_ingredients   enable row level security;

create policy "staff_all_purchase_orders"
  on public.purchase_orders for all
  using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

create policy "staff_all_po_items"
  on public.purchase_order_items for all
  using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

create policy "staff_all_recipes"
  on public.recipes for all
  using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

create policy "auth_read_recipes"
  on public.recipes for select
  using (auth.uid() is not null);

create policy "staff_all_recipe_ingredients"
  on public.recipe_ingredients for all
  using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

create policy "auth_read_recipe_ingredients"
  on public.recipe_ingredients for select
  using (auth.uid() is not null);

-- Index for fast PO item lookups by inventory item
create index if not exists poi_inventory_id_idx on public.purchase_order_items(inventory_id);
create index if not exists ri_inventory_id_idx  on public.recipe_ingredients(inventory_id);
