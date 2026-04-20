-- Performance: add missing indexes on high-traffic columns and mark
-- is_owner_or_staff() as STABLE so Postgres can cache the result
-- within a single query plan instead of re-executing the students
-- subquery once per row.

-- orders: customer dashboards, admin date/status filters, RLS scans
create index if not exists idx_orders_user_id    on public.orders (user_id);
create index if not exists idx_orders_created_at on public.orders (created_at desc);
create index if not exists idx_orders_status     on public.orders (status);

-- subscriptions: customer dashboard active-plan lookup, admin counts
create index if not exists idx_subscriptions_user_id on public.subscriptions (user_id);
create index if not exists idx_subscriptions_status  on public.subscriptions (status);

-- students: RLS badge queries and is_owner_or_staff() role lookup
create index if not exists idx_students_role on public.students (role);

-- Mark STABLE so Postgres can cache the result across rows in one query.
-- The function reads only immutable session state (auth.uid / JWT email)
-- and a single students row, so the return value is constant for the
-- lifetime of any single statement.
create or replace function public.is_owner_or_staff()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_role  text;
begin
  if v_email = 'tylerkillen@nixaschools.net' then
    return true;
  end if;

  if v_uid is null then
    return false;
  end if;

  select s.role into v_role
  from public.students s
  where s.id = v_uid
  limit 1;

  return v_role in ('admin', 'manager');
end;
$$;
