-- Loyalty system: track money spent toward $3 credit rewards
-- $25 spent (non-subscription) = $3 credit
-- Credits apply to menu orders only; subscriptions are excluded from earning and using credits

-- Add credit_used_cents to orders so we can see how much reward credit was applied per order
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS credit_used_cents INTEGER DEFAULT 0;

-- Add loyalty columns to profiles so the admin panel can display them without
-- querying auth user metadata directly. These are kept in sync by the
-- process-payment edge function after each successful order.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS loyalty_spend_cents  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_credit_cents INTEGER DEFAULT 0;
