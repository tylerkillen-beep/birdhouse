-- Customers can't set their own subscription discount.
--
-- discount_pct is what charge-subscriptions takes off every weekly charge. It
-- used to be sent by the subscribe page and written from the browser, so
-- anyone who edited the request, or updated their own subscriptions row, could
-- pick their own discount. save-card now works it out from the account (25%
-- for high school teachers, 0 for everyone else, Mathews included), and this
-- trigger stops a browser session from changing it afterwards.
--
-- The customer's own-row policy still lets them pause, resume and cancel; only
-- this column is locked. save-card and charge-subscriptions run as the service
-- role, and the SQL editor runs as postgres, so neither is affected. Admins
-- and managers can still change it.

create or replace function public.guard_subscription_discount()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Browser requests arrive as anon or authenticated; everything else is a
  -- server-side caller that has already done its own checks.
  if current_user not in ('anon', 'authenticated') or public.is_owner_or_staff() then
    return new;
  end if;

  if tg_op = 'INSERT' and coalesce(new.discount_pct, 0) <> 0 then
    raise exception 'Subscription discounts are set by the Birdhouse, not the browser.';
  end if;

  if tg_op = 'UPDATE' and new.discount_pct is distinct from old.discount_pct then
    raise exception 'Subscription discounts are set by the Birdhouse, not the browser.';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_subscription_discount on public.subscriptions;
create trigger guard_subscription_discount
  before insert or update on public.subscriptions
  for each row execute function public.guard_subscription_discount();
