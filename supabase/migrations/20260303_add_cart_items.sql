-- Migration: multi-item cart support for orders table
-- Run this in: Supabase Dashboard → SQL Editor

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cart_items       JSONB,
  ADD COLUMN IF NOT EXISTS total_amount     NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS square_payment_id TEXT;

-- Optional: index cart_items for faster queries if needed
-- CREATE INDEX IF NOT EXISTS idx_orders_cart_items ON orders USING GIN (cart_items);

-- cart_items stores an array of objects, e.g.:
-- [
--   { "id": "uuid", "name": "Latte", "temp": "hot",  "price": 4.50, "quantity": 2 },
--   { "id": "uuid", "name": "Mocha", "temp": "iced", "price": 5.00, "quantity": 1 }
-- ]
