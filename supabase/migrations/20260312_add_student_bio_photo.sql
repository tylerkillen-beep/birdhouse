-- Add photo support for student bio submissions shown on the public About page.

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS bio_photo_url text,
  ADD COLUMN IF NOT EXISTS bio_photo_pending_url text;

-- Public bucket for approved/pending bio photos (URLs are rendered on admin and homepage).
INSERT INTO storage.buckets (id, name, public)
VALUES ('student-bio-photos', 'student-bio-photos', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Students upload own bio photos'
  ) THEN
    CREATE POLICY "Students upload own bio photos" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'student-bio-photos'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Students update own bio photos'
  ) THEN
    CREATE POLICY "Students update own bio photos" ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'student-bio-photos'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
      WITH CHECK (
        bucket_id = 'student-bio-photos'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Students delete own bio photos'
  ) THEN
    CREATE POLICY "Students delete own bio photos" ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'student-bio-photos'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Public read bio photos'
  ) THEN
    CREATE POLICY "Public read bio photos" ON storage.objects
      FOR SELECT TO public
      USING (bucket_id = 'student-bio-photos');
  END IF;
END $$;
