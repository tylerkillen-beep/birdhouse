-- Backfill full_name and email for student profiles that are missing them.
-- Students (@nixastudents.net) bypassed the profile upsert on login, so their
-- profiles rows exist (created by process-payment) but have null/blank names.
-- Pull the values directly from auth.users metadata, matching the same logic
-- used in the login flow.

UPDATE public.profiles p
SET
  email     = u.email,
  full_name = COALESCE(
                NULLIF(TRIM(
                  COALESCE(u.raw_user_meta_data->>'first_name', '') || ' ' ||
                  COALESCE(u.raw_user_meta_data->>'last_name',  '')
                ), ' '),
                u.email
              )
FROM auth.users u
WHERE p.id = u.id
  AND u.email ILIKE '%@nixastudents.net'
  AND (p.full_name IS NULL OR p.full_name = '');
