-- Allow customers to read their own orders.
-- Previously only staff/admin had access to the orders table via RLS,
-- meaning regular customers could not see their own order history.

create policy orders_customer_select_own_policy
on public.orders
for select
using (auth.uid() = user_id);
