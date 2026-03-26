-- Add order tracking fields to inventory items
-- Tracks when a supply was last ordered and when it's expected to arrive

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS last_ordered_at date,
  ADD COLUMN IF NOT EXISTS expected_arrival date;
