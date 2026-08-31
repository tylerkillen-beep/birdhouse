-- Sticker sheets: customers upload images, arrange them on a 4in x 7in sheet,
-- pay online, and pick a delivery slot.  Staff review each sheet before it is
-- printed on the Liene Pixcut S1, then download the composed 300 DPI file.
--
-- Pricing (enforced server-side in the process-payment edge function):
--   $2.00 per sheet + $0.25 per unique uploaded image beyond the first.
--   Placing the same image many times on one sheet costs nothing extra.

-- Private bucket for uploads + composed print files.
-- Private (unlike student-bio-photos) because these are customer images that
-- have not been reviewed yet.  Staff read them through signed URLs.
insert into storage.buckets (id, name, public)
values ('sticker-uploads', 'sticker-uploads', false)
on conflict (id) do nothing;

create table if not exists public.sticker_sheets (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  order_id            uuid references public.orders (id) on delete set null,

  -- Layout preset id ('1x1', '2x1', '2x2', '3x2', '3x3', '4x4') and the
  -- per-slot placement: [{ slot, imageId, zoom, offsetX, offsetY }]
  layout_preset       text not null,
  slots               jsonb not null default '[]'::jsonb,

  -- Uploaded originals: [{ id, path, name, width, height, bytes }]
  images              jsonb not null default '[]'::jsonb,

  unique_image_count  int  not null default 0,
  placed_count        int  not null default 0,
  price_cents         int  not null default 0,

  -- Storage path of the composed 1200 x 2100 print file
  print_path          text,

  -- draft -> pending_review -> approved -> printed, or rejected
  status              text not null default 'draft',
  review_note         text,
  reviewed_by         uuid references auth.users (id) on delete set null,
  reviewed_at         timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint sticker_sheets_status_check check (
    status in ('draft', 'pending_review', 'approved', 'rejected', 'printed')
  ),
  constraint sticker_sheets_placed_count_check check (placed_count between 0 and 16),
  constraint sticker_sheets_unique_image_check check (unique_image_count between 0 and 16)
);

create index if not exists idx_sticker_sheets_user_id  on public.sticker_sheets (user_id);
create index if not exists idx_sticker_sheets_order_id on public.sticker_sheets (order_id);
create index if not exists idx_sticker_sheets_status   on public.sticker_sheets (status);

alter table public.sticker_sheets enable row level security;

-- Customers: full control over their own drafts, read-only once submitted.
drop policy if exists sticker_sheets_owner_select on public.sticker_sheets;
create policy sticker_sheets_owner_select on public.sticker_sheets
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists sticker_sheets_owner_insert on public.sticker_sheets;
create policy sticker_sheets_owner_insert on public.sticker_sheets
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'draft');

-- A draft may be edited freely.  Once it is paid for it locks: the update must
-- both start and stay in 'draft', so a customer cannot approve their own sheet
-- or edit artwork that staff have already reviewed.
drop policy if exists sticker_sheets_owner_update on public.sticker_sheets;
create policy sticker_sheets_owner_update on public.sticker_sheets
  for update to authenticated
  using  (user_id = auth.uid() and status = 'draft')
  with check (user_id = auth.uid() and status = 'draft');

drop policy if exists sticker_sheets_owner_delete on public.sticker_sheets;
create policy sticker_sheets_owner_delete on public.sticker_sheets
  for delete to authenticated
  using (user_id = auth.uid() and status = 'draft');

-- Staff (student, manager, admin) read every submitted sheet for the queue.
drop policy if exists sticker_sheets_staff_select on public.sticker_sheets;
create policy sticker_sheets_staff_select on public.sticker_sheets
  for select to authenticated
  using (
    exists (
      select 1 from public.students s
      where s.id = auth.uid()
        and s.role in ('student', 'manager', 'admin')
    )
  );

-- Only managers/admins approve, reject, or mark printed.
drop policy if exists sticker_sheets_staff_update on public.sticker_sheets;
create policy sticker_sheets_staff_update on public.sticker_sheets
  for update to authenticated
  using (public.is_owner_or_staff())
  with check (public.is_owner_or_staff());

-- Storage policies.  Uploads live at {user_id}/{sheet_id}/{filename}, so the
-- first path segment is the owner -- same convention as student-bio-photos.
do $policies$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Customers upload own sticker images'
  ) then
    create policy "Customers upload own sticker images" on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'sticker-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Customers update own sticker images'
  ) then
    create policy "Customers update own sticker images" on storage.objects
      for update to authenticated
      using (
        bucket_id = 'sticker-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
      with check (
        bucket_id = 'sticker-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Customers read own sticker images'
  ) then
    create policy "Customers read own sticker images" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'sticker-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Customers delete own sticker images'
  ) then
    create policy "Customers delete own sticker images" on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'sticker-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;

  -- Staff read every sticker upload so they can review and print.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Staff read sticker uploads'
  ) then
    create policy "Staff read sticker uploads" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'sticker-uploads'
        and exists (
          select 1 from public.students s
          where s.id = auth.uid()
            and s.role in ('student', 'manager', 'admin')
        )
      );
  end if;
end
$policies$;

create or replace function public.touch_sticker_sheet()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_touch_sticker_sheet on public.sticker_sheets;
create trigger trg_touch_sticker_sheet
  before update on public.sticker_sheets
  for each row execute function public.touch_sticker_sheet();

-- Distinguish sticker orders from coffee orders so each queue can filter its
-- own work.  Existing rows are all menu orders.
alter table public.orders
  add column if not exists order_type text not null default 'menu';

do $ordertype$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_order_type_check'
  ) then
    alter table public.orders
      add constraint orders_order_type_check
      check (order_type in ('menu', 'stickers'));
  end if;
end
$ordertype$;

create index if not exists idx_orders_order_type on public.orders (order_type);
