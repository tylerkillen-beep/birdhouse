-- Add customer location (high_school | mathews) and last_room to profiles.
-- Teachers at Mathews Middle School are flagged via location='mathews';
-- all other @nixaschools.net accounts default to 'high_school'.
-- last_room remembers the delivery room a customer last used.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS location TEXT DEFAULT 'high_school',
  ADD COLUMN IF NOT EXISTS last_room TEXT;

-- Track teacher discount percentage on subscriptions so recurring billing
-- can apply the same discount. Default 0 = no discount (students).
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS discount_pct INTEGER NOT NULL DEFAULT 0;
