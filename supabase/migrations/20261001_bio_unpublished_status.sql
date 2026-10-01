-- Let an admin pull an approved bio off the About page without deleting it.
-- The About and lobby pages only show bio_status = 'approved', so any other
-- status hides the bio. 'unpublished' keeps the text so it can be republished.
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_bio_status_check;
ALTER TABLE students
  ADD CONSTRAINT students_bio_status_check
  CHECK (bio_status IN ('pending', 'approved', 'rejected', 'unpublished'));
