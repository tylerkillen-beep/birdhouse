-- Backfill loyalty_spend_cents and loyalty_credit_cents for all users from
-- their complete order history.
--
-- Context: loyalty columns were added to profiles with DEFAULT 0.  The
-- process-payment edge function only updates them going forward, so users with
-- orders placed before the loyalty system was introduced show $0.00 even
-- though they have real spend history.
--
-- This migration computes the authoritative totals from the orders table and
-- writes them to profiles.  It is safe to re-run: it overwrites all rows that
-- have matching order data (idempotent because it re-derives from source truth).

UPDATE profiles p
SET
  loyalty_spend_cents = agg.total_spend_cents,
  loyalty_credit_cents = GREATEST(
    0,
    (FLOOR(agg.total_spend_cents::numeric / 2500) * 300)::integer
    - agg.total_credit_used_cents
  )
FROM (
  SELECT
    user_id,
    SUM(ROUND(total_amount * 100))::integer      AS total_spend_cents,
    SUM(COALESCE(credit_used_cents, 0))::integer AS total_credit_used_cents
  FROM orders
  WHERE status = 'paid'
    AND total_amount IS NOT NULL
    AND total_amount > 0
  GROUP BY user_id
) agg
WHERE p.id = agg.user_id;
