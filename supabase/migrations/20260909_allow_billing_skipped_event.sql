-- Allow the billing_skipped subscription event.
--
-- charge-subscriptions records billing_skipped when it deliberately does not
-- charge a subscriber for a week in which every one of their delivery days is
-- closed. The existing CHECK constraint predates that behaviour and rejects the
-- value, so the skip is silently missing from the student's visible history —
-- exactly the line that explains why they were not billed.
--
-- Billing itself never depended on this: the function logs a warning and
-- carries on when the insert is refused.

do $$
begin
  if to_regclass('public.subscription_events') is null then
    return;
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.subscription_events'::regclass
      and conname = 'subscription_events_event_type_check'
  ) then
    alter table public.subscription_events
      drop constraint subscription_events_event_type_check;
  end if;

  -- Same list as before, plus billing_skipped. Adding the constraint revalidates
  -- every existing row, so this fails loudly rather than quietly if any row
  -- holds a value outside the list.
  alter table public.subscription_events
    add constraint subscription_events_event_type_check
    check (event_type = any (array[
      'created'::text,
      'charged'::text,
      'charge_failed'::text,
      'paused'::text,
      'resumed'::text,
      'cancelled'::text,
      'plan_changed'::text,
      'drink_changed'::text,
      'card_updated'::text,
      'billing_skipped'::text
    ]));
end $$;
