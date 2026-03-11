-- Student bios for the public "Meet the Team" section on the About page.
-- Students submit a bio from their Team Hub; the admin reviews and approves it.
-- Once approved, the bio becomes publicly visible on the homepage.

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS bio         text,          -- approved bio (public)
  ADD COLUMN IF NOT EXISTS bio_pending text,          -- submitted but not yet reviewed
  ADD COLUMN IF NOT EXISTS bio_status  text           -- null | 'pending' | 'approved' | 'rejected'
    CHECK (bio_status IN ('pending', 'approved', 'rejected'));

-- Students can update their own bio_pending and bio_status (to submit for review)
CREATE POLICY "Students can submit their own bio" ON students
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Anyone (including unauthenticated visitors) can read approved bios for the About page
CREATE POLICY "Public can read approved bios" ON students
  FOR SELECT USING (bio_status = 'approved');
