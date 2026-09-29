-- The admin Subscriptions tab lists each subscriber's drinks and delivery
-- day/time, but subscription_drink_slots only let a subscriber read their own
-- rows, so an admin saw slots for their own subscription and blanks for
-- everyone else's. Let staff read them, the same way subscriptions_staff_all_policy
-- lets staff see the subscriptions themselves.

drop policy if exists subscription_drink_slots_staff_read on public.subscription_drink_slots;

create policy subscription_drink_slots_staff_read
on public.subscription_drink_slots
for select
using (public.is_owner_or_staff());
