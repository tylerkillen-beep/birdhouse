-- Add customer_location to orders so the order queue can distinguish
-- Mathews deliveries from high-school orders.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_location TEXT;
