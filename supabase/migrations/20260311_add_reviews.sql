-- Customer drink reviews
-- Customers can leave a star rating (1-5) and optional written review
-- on drinks from their delivered orders. Reviews are soft-deleted by admin.

CREATE TABLE IF NOT EXISTS reviews (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  menu_item_id  uuid REFERENCES menu_items(id) ON DELETE CASCADE NOT NULL,
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  rating        integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text   text,
  reviewer_name text,
  created_at    timestamptz DEFAULT now() NOT NULL,
  deleted_at    timestamptz DEFAULT NULL
);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- Anyone (including unauthenticated) can read non-deleted reviews
CREATE POLICY "Public read active reviews" ON reviews
  FOR SELECT USING (deleted_at IS NULL);

-- Authenticated customers can submit reviews for themselves
CREATE POLICY "Users insert own reviews" ON reviews
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Admin (students with role='admin') can soft-delete reviews by setting deleted_at
CREATE POLICY "Admin can soft-delete reviews" ON reviews
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM students
      WHERE students.id = auth.uid()
        AND students.role = 'admin'
    )
  );

-- One active review per user per menu item per order
CREATE UNIQUE INDEX IF NOT EXISTS reviews_unique_per_order_item
  ON reviews (user_id, menu_item_id, order_id)
  WHERE deleted_at IS NULL;
