-- Separate blocked-dates table for the Mathews location.
-- The existing blocked_dates table controls the main Birdhouse calendar.
-- mathews_blocked_dates controls the Mathews calendar (M/W/F only).
-- When an admin closes a M/W/F main date the application also writes here automatically.

CREATE TABLE IF NOT EXISTS mathews_blocked_dates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE NOT NULL UNIQUE,
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE mathews_blocked_dates ENABLE ROW LEVEL SECURITY;

-- Customers and staff can read Mathews blocked dates (needed on the order page)
CREATE POLICY "Anyone can read mathews blocked dates"
  ON mathews_blocked_dates FOR SELECT
  USING (true);

-- Only staff/admins can insert, update, or delete Mathews blocked dates
CREATE POLICY "Staff can manage mathews blocked dates"
  ON mathews_blocked_dates FOR ALL
  USING (is_owner_or_staff())
  WITH CHECK (is_owner_or_staff());
