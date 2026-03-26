-- Create modifier_lists table if it doesn't exist
create table if not exists modifier_lists (
  id uuid primary key default gen_random_uuid(),
  square_id text not null,
  name text not null default '',
  created_at timestamptz not null default now()
);

-- Create modifier_options table if it doesn't exist
create table if not exists modifier_options (
  id uuid primary key default gen_random_uuid(),
  modifier_list_id uuid not null references modifier_lists(id) on delete cascade,
  square_id text not null,
  name text not null default '',
  price_cents integer not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Add unique constraints on square_id so upserts work correctly
alter table modifier_lists
  add constraint if not exists modifier_lists_square_id_key unique (square_id);

alter table modifier_options
  add constraint if not exists modifier_options_square_id_key unique (square_id);

-- Allow customers to read modifier data (needed by order and subscribe pages)
alter table modifier_lists enable row level security;
alter table modifier_options enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'modifier_lists' and policyname = 'modifier_lists_public_read'
  ) then
    create policy modifier_lists_public_read on modifier_lists
      for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'modifier_options' and policyname = 'modifier_options_public_read'
  ) then
    create policy modifier_options_public_read on modifier_options
      for select using (true);
  end if;
end $$;
