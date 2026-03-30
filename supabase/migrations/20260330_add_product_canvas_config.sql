-- Add product performance assignment fields to canvas_config
-- Shape additions:
--   product_assignment_id: string,  Canvas assignment ID for product performance scores
--   product_points: number          Max points on the Canvas product assignment (default 10)

UPDATE store_config
SET value = value || '{"product_assignment_id": "", "product_points": 10}'::jsonb
WHERE key = 'canvas_config'
  AND NOT (value ? 'product_assignment_id');
