-- Email intake: orders arrive by forwarded email instead of an uploaded receipt.
--
-- Amazon and Walmart order emails are forwarded into a Gmail inbox; a small
-- Google Apps Script there posts each one to the ingest-order-email edge
-- function, which reads it (the same reader as receipt uploads) and either
--
--   * attaches it to the order you placed from Needs Ordering (filling in the
--     order number, date and expected arrival),
--   * updates an order it already has (a shipping notice with a new arrival date),
--   * or creates a new pending order, which managers confirm arriving.
--
-- Stock only ever changes when a manager confirms an arrival, so a wrong or
-- duplicate order from an email can't move a count by itself.
--
-- order_emails is the log of every email the function saw and what it did with
-- it, so a missing order can be traced. Orders it isn't sure about are flagged
-- needs_review (a line it couldn't match to inventory, a pack size it couldn't
-- read, or an email that lists fewer items than the order has -- Amazon Business
-- approval emails do) and appear in Admin > Purchases for a quick check.
--
-- Safe to run more than once.

alter table public.purchase_orders
  add column if not exists needs_review boolean not null default false,
  add column if not exists review_note  text;

create table if not exists public.order_emails (
  id                uuid primary key default gen_random_uuid(),
  message_id        text not null unique,
  received_at       timestamptz,
  from_address      text,
  subject           text,
  kind              text,
  vendor            text,
  order_numbers     text[] not null default '{}',
  status            text not null check (status in ('created', 'matched', 'updated', 'duplicate', 'ignored', 'error')),
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  note              text,
  parsed            jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists order_emails_created_idx on public.order_emails (created_at desc);
create index if not exists order_emails_po_idx      on public.order_emails (purchase_order_id);

alter table public.order_emails enable row level security;
drop policy if exists staff_read_order_emails on public.order_emails;
create policy staff_read_order_emails on public.order_emails for select using (public.is_owner_or_staff());

-- Only the edge function (service role) writes; staff read the log.
grant select on public.order_emails to authenticated;
grant all    on public.order_emails to service_role;

-- Check it:
--   select created_at, status, kind, vendor, order_numbers, subject, note
--   from public.order_emails order by created_at desc limit 30;
