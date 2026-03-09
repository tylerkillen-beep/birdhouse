-- Add customer_name and item_name columns to orders table.
-- These are used by the admin dashboard to display order details
-- without having to parse the cart_items JSONB array.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_name TEXT,
  ADD COLUMN IF NOT EXISTS item_name     TEXT;
