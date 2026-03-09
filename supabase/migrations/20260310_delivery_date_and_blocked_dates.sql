-- Add delivery_date column to orders for individual order date selection.
-- Subscriptions continue using delivery_day (day of week text).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_date DATE;

-- Table for admin-blocked calendar days (closures, holidays, etc.)
CREATE TABLE IF NOT EXISTS blocked_dates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE NOT NULL UNIQUE,
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE blocked_dates ENABLE ROW LEVEL SECURITY;

-- Customers and staff can read blocked dates (needed on the order page)
CREATE POLICY "Anyone can read blocked dates"
  ON blocked_dates FOR SELECT
  USING (true);

-- Only staff/admins can insert, update, or delete blocked dates
CREATE POLICY "Staff can manage blocked dates"
  ON blocked_dates FOR ALL
  USING (is_owner_or_staff())
  WITH CHECK (is_owner_or_staff());

-- Update delivery_times in store_config to the full 7:30 AM – 1:30 PM
-- every-30-minute schedule. Uses upsert so existing installs are updated.
INSERT INTO store_config (key, value)
VALUES (
  'delivery_times',
  '["7:30 AM","8:00 AM","8:30 AM","9:00 AM","9:30 AM","10:00 AM","10:30 AM","11:00 AM","11:30 AM","12:00 PM","12:30 PM","1:00 PM","1:30 PM"]'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
