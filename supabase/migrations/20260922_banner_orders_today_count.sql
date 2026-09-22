-- Live order count for the ScreenCloud banner (/banner.html).
--
-- The banner runs signed out, and orders RLS only exposes a customer's own
-- rows or staff rows -- an anon request gets back an empty list with a 200,
-- so a client-side count would sit at zero forever. This hands out the single
-- integer the banner needs and nothing else.
--
-- The count covers every channel:
--
--   orders            -- the website, plus subscription drinks
--   square_sale_lines -- the register and Square Online
--
-- Those two never overlap. sync-square-sales drops any Square order whose
-- tender matches a square_payment_id already in orders or in
-- subscription_charges, precisely so a website sale is not recorded twice, so
-- adding the two together cannot double-count. square_sale_lines is one row
-- per line item, so the register side counts distinct orders, not drinks.
--
-- The two halves are dated on different things, because that is what each one
-- means. A website order counts on the day it is FOR (delivery_date), which
-- matches the staff queue's Total Today. A register sale has no such day --
-- it is handed over when it is rung up -- so it counts on the day it closed.
--
-- One deliberate difference from the staff queue: cancelled orders don't
-- count. The queue shows them because staff need the full picture of the day;
-- a number on a wall should not be inflated by orders nobody received.
--
-- NOTE: the register half is only as current as the last sync-square-sales
-- run, which today happens when a staff member presses Sync on the Item
-- Lookup tab. Until that runs on a schedule, the banner under-reports
-- register sales made since the last press.

create or replace function public.orders_today_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (
    (select count(*)
       from public.orders
      where delivery_date = (now() at time zone 'America/Chicago')::date
        and coalesce(status, '') <> 'cancelled')
    +
    -- A half-open range on closed_at rather than a cast to date, so the
    -- square_sale_lines closed_at index can still be used.
    (select count(distinct square_order_id)
       from public.square_sale_lines
      where closed_at >= date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago'
        and closed_at <  (date_trunc('day', now() at time zone 'America/Chicago') + interval '1 day') at time zone 'America/Chicago')
  )::integer;
$$;

grant execute on function public.orders_today_count() to anon, authenticated;

comment on function public.orders_today_count() is
  'Count of today''s orders across every channel (America/Chicago): non-cancelled website and subscription orders due today, plus distinct register and Square Online orders closed today. Readable by anon for the lobby banner.';
