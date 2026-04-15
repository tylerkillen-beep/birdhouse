-- Update NHS (high school) delivery times from every-30-minute to every-15-minute
-- schedule, 7:30 AM – 1:30 PM. Mathews users have hardcoded slots in the app
-- and are unaffected by this config entry.
INSERT INTO store_config (key, value)
VALUES (
  'delivery_times',
  '["7:30 AM","7:45 AM","8:00 AM","8:15 AM","8:30 AM","8:45 AM","9:00 AM","9:15 AM","9:30 AM","9:45 AM","10:00 AM","10:15 AM","10:30 AM","10:45 AM","11:00 AM","11:15 AM","11:30 AM","11:45 AM","12:00 PM","12:15 PM","12:30 PM","12:45 PM","1:00 PM","1:15 PM","1:30 PM"]'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
