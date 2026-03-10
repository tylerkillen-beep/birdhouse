-- Add delivery_method to orders table
-- 'delivery' = delivered to room (default, existing behavior)
-- 'pickup'   = customer picks up at the Birdhouse (library)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'delivery';
