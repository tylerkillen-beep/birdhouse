-- Track the quantity currently on order for each inventory item.
-- Set when an order is logged; can be cleared or overwritten on the next order.

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS ordered_quantity numeric DEFAULT NULL;
