-- Profit & Loss support.
--
--   business_expenses   costs that aren't ingredients or supplies from a receipt:
--                       equipment, training, labor, fees. Entered by hand on the
--                       Profit & Loss page.
--   pnl_monthly_cogs()  what the food and supplies we SOLD cost, by month: every
--                       recorded sale's ingredient usage (app orders, register and
--                       Square Online sales, subscription drinks) times each
--                       ingredient's latest receipt cost. Compare it with what the
--                       receipts say we BOUGHT to see waste and unlinked items.
--
-- Costs use the latest receipt price, so old months reprice as prices change.
-- Usage is only recorded from when each deduction switch was turned on (or
-- backfilled), so older months can read low. Safe to run more than once.

create table if not exists public.business_expenses (
  id           uuid primary key default gen_random_uuid(),
  expense_date date    not null,
  category     text    not null default 'other'
               check (category in ('equipment', 'training', 'labor', 'fees', 'other')),
  description  text    not null,
  amount_cents integer not null check (amount_cents >= 0),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

create index if not exists business_expenses_date_idx on public.business_expenses (expense_date);

alter table public.business_expenses enable row level security;
drop policy if exists staff_all_business_expenses on public.business_expenses;
create policy staff_all_business_expenses on public.business_expenses
  for all using (public.is_owner_or_staff()) with check (public.is_owner_or_staff());

grant select, insert, update, delete on public.business_expenses to authenticated;
grant all on public.business_expenses to service_role;

-- month is the first day of the month in Central time.
create or replace function public.pnl_monthly_cogs(p_from timestamptz, p_to timestamptz)
returns table (month date, cost_cents numeric, lines bigint, uncosted_lines bigint)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_union text := '';
  t text;
begin
  foreach t in array array['order_inventory_usage', 'square_line_inventory_usage', 'subscription_delivery_usage'] loop
    if to_regclass('public.' || t) is not null then
      v_union := v_union || case when v_union = '' then '' else ' union all ' end
        || format('select sold_at, inventory_id, base_amount from public.%I where sold_at >= $1 and sold_at < $2', t);
    end if;
  end loop;

  if v_union = '' then
    return;
  end if;

  return query execute format($q$
    select date_trunc('month', u.sold_at at time zone 'America/Chicago')::date,
           coalesce(sum(u.base_amount * i.cost_per_base_unit_cents), 0)::numeric,
           count(*),
           count(*) filter (where i.cost_per_base_unit_cents is null)
    from (%s) u
    join public.inventory i on i.id = u.inventory_id
    group by 1
    order by 1
  $q$, v_union) using p_from, p_to;
end;
$$;

grant execute on function public.pnl_monthly_cogs(timestamptz, timestamptz) to authenticated, service_role;
