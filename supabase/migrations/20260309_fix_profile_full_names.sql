-- Backfill profiles.full_name for users whose full_name is stored as their
-- email address (happens when Google OAuth users log in and the metadata
-- fields given_name/family_name were not checked during upsert).
--
-- Priority: first_name + last_name > given_name + family_name > full_name > name
-- Only updates rows where full_name currently looks like an email.

UPDATE public.profiles p
SET full_name = COALESCE(
  NULLIF(TRIM(
    CONCAT_WS(' ',
      NULLIF(TRIM(COALESCE(
        u.raw_user_meta_data->>'first_name',
        u.raw_user_meta_data->>'given_name',
        ''
      )), ''),
      NULLIF(TRIM(COALESCE(
        u.raw_user_meta_data->>'last_name',
        u.raw_user_meta_data->>'family_name',
        ''
      )), '')
    )
  ), ''),
  NULLIF(TRIM(COALESCE(
    u.raw_user_meta_data->>'full_name',
    u.raw_user_meta_data->>'name',
    ''
  )), ''),
  p.full_name
)
FROM auth.users u
WHERE p.id = u.id
  AND p.full_name LIKE '%@%';
