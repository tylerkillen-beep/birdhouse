-- Add blocked_slots table for partial-day closures (specific time + location).
-- Unlike blocked_dates (which blocks whole days), this allows blocking individual
-- timeslots at a specific location while keeping other times available.
CREATE TABLE IF NOT EXISTS blocked_slots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE NOT NULL,
  time       TEXT NOT NULL,
  location   TEXT NOT NULL,  -- e.g. 'mathews', 'high_school'
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (date, time, location)
);

ALTER TABLE blocked_slots ENABLE ROW LEVEL SECURITY;

-- Customers and staff can read blocked slots (needed on the order page)
CREATE POLICY "Anyone can read blocked slots"
  ON blocked_slots FOR SELECT
  USING (true);

-- Only staff/admins can insert, update, or delete blocked slots
CREATE POLICY "Staff can manage blocked slots"
  ON blocked_slots FOR ALL
  USING (is_owner_or_staff())
  WITH CHECK (is_owner_or_staff());

-- Block Mathews 8:15 AM morning slot on specific dates.
-- The 12:00 PM afternoon slot remains open on all of these days.
INSERT INTO blocked_slots (date, time, location, reason) VALUES
  ('2026-04-15', '8:15 AM', 'mathews', 'Morning delivery unavailable'),
  ('2026-04-17', '8:15 AM', 'mathews', 'Morning delivery unavailable'),
  ('2026-04-24', '8:15 AM', 'mathews', 'Morning delivery unavailable'),
  ('2026-04-29', '8:15 AM', 'mathews', 'Morning delivery unavailable'),
  ('2026-05-01', '8:15 AM', 'mathews', 'Morning delivery unavailable')
ON CONFLICT (date, time, location) DO NOTHING;
