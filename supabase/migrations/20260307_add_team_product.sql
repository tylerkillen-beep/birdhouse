-- Add product assignment and cost tracking to teams
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS product_name TEXT,
  ADD COLUMN IF NOT EXISTS cost_cents   INTEGER DEFAULT 0;
