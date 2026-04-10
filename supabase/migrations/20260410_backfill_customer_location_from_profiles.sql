-- Backfill customer_location for orders that were placed before the column was
-- added (20260407) or before the server-side derivation fix (20260410).
--
-- Logic mirrors process-payment: @nixaschools.net users are teachers; their
-- campus is whatever profile.location says ('mathews' or 'high_school').
-- Everyone else is a student.
--
-- Safe to re-run: only touches rows where customer_location is NULL or where
-- a Mathews teacher's order was incorrectly stored as 'teacher'.

-- 1. Mathews teachers: fix null or wrongly-stored 'teacher' orders
UPDATE public.orders o
SET    customer_location = 'mathews'
FROM   public.profiles p
WHERE  o.user_id = p.id
  AND  p.location = 'mathews'
  AND  (o.customer_location IS NULL OR o.customer_location = 'teacher');

-- 2. High-school teachers: fill in nulls (won't touch already-correct rows)
UPDATE public.orders o
SET    customer_location = 'teacher'
FROM   public.profiles p
WHERE  o.user_id = p.id
  AND  p.location != 'mathews'
  AND  p.email LIKE '%@nixaschools.net'
  AND  o.customer_location IS NULL;

-- 3. Students: any remaining nulls belong to non-staff accounts
UPDATE public.orders o
SET    customer_location = 'student'
FROM   public.profiles p
WHERE  o.user_id = p.id
  AND  p.email NOT LIKE '%@nixaschools.net'
  AND  o.customer_location IS NULL;
