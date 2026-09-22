-- Top sales for the ScreenCloud banner (/banner.html).
--
-- Replaces orders_today_count(), which counted the day's orders. The banner
-- now shows the biggest single sale of the day and of the week, to run a
-- free-drink deal off the weekly one.
--
-- Website orders only. Every one carries a real customer_name, so the board is
-- always nameable and the prize is always awardable; a cash walk-in at the
-- register usually has no Square customer attached and could not be credited.
--
-- NOTE: this is the largest single ORDER, not the largest total spend. Someone
-- who buys one big round tops the week over someone who buys a little every
-- day. That is the chosen behaviour -- if the deal is ever described as
-- "top spender", this function is not what decides it.
--
-- The endpoint is public, so it deliberately gives out as little as it can:
-- one amount and a shortened name per row, never a full name, an order id or a
-- customer id. The shortening happens here rather than in the page so that a
-- full name never leaves the database.

drop function if exists public.orders_today_count();

create or replace function public.banner_top_sales()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with scope as (
    select (now() at time zone 'America/Chicago')::date                    as today,
           date_trunc('week', now() at time zone 'America/Chicago')::date  as week_start
  ),
  sales as (
    -- "Maddox Moore" -> "Maddox M." A one-word name doesn't match and is left
    -- alone; a middle name is skipped in favour of the last initial.
    select o.delivery_date,
           o.total_amount,
           regexp_replace(trim(o.customer_name), '^(\S+).*\s(\S)\S*$', '\1 \2.') as display_name
      from public.orders o, scope
     where o.delivery_date between scope.week_start and scope.today
       and coalesce(o.status, '') <> 'cancelled'
       and o.total_amount > 0
       and coalesce(trim(o.customer_name), '') <> ''
  )
  select jsonb_build_object(
    'today', (select jsonb_build_object('amount', s.total_amount, 'name', s.display_name)
                from sales s, scope
               where s.delivery_date = scope.today
               order by s.total_amount desc
               limit 1),
    'week',  (select jsonb_build_object('amount', s.total_amount, 'name', s.display_name)
                from sales s
               order by s.total_amount desc
               limit 1)
  );
$$;

grant execute on function public.banner_top_sales() to anon, authenticated;

comment on function public.banner_top_sales() is
  'Largest single website order today and this week (America/Chicago, week starts Monday), as {today:{amount,name},week:{amount,name}} with names shortened to a first name and last initial. Readable by anon for the lobby banner.';
