-- Manual override for which reviews the lobby banner rotates through.
--   true  = always show on the banner
--   false = never show on the banner
--   null  = automatic (the rules in lib/banner-reviews.js)
-- Admins already have UPDATE on reviews (see 20260311_add_reviews.sql), and
-- the banner reads it with the anon key like the rest of the review columns.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS banner_pin boolean;
