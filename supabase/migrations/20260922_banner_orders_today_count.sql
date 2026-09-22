-- Live order count for the ScreenCloud banner (/banner.html).
--
-- The banner runs signed out, and orders RLS only exposes a customer's own
-- rows or staff rows -- an anon request gets back an empty list with a 200,
-- so a client-side count would sit at zero forever. This hands out the single
-- integer the banner needs and nothing else.
--
-- "Today" means the day an order is FOR (delivery_date), matching the staff
-- queue's Total Today stat, not the day it was placed. Orders old enough to
-- predate delivery_date carry only a weekday name; the queue resolves those
-- to the first matching weekday on or after they were placed, which can never
-- land on today, so ignoring them here keeps the two numbers in step.
--
-- One deliberate difference from the staff queue: cancelled orders don't
-- count. The queue shows them because staff need the full picture of the day;
-- a number on a wall should not be inflated by orders nobody received.

create or replace function public.orders_today_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.orders
   where delivery_date = (now() at time zone 'America/Chicago')::date
     and coalesce(status, '') <> 'cancelled';
$$;

grant execute on function public.orders_today_count() to anon, authenticated;

comment on function public.orders_today_count() is
  'Count of non-cancelled orders due today (America/Chicago). Readable by anon for the lobby banner.';
