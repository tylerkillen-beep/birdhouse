-- Allow students to see all members of their own team.
-- Needed for peer evaluation: students query teammates by team_id,
-- but the existing select policy only lets students see their own row.
--
-- SECURITY DEFINER on get_my_team_id() is required to avoid recursive
-- RLS (the function reads students without triggering the policy).

CREATE OR REPLACE FUNCTION public.get_my_team_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team_id uuid;
BEGIN
  SELECT team_id INTO v_team_id FROM students WHERE id = auth.uid() LIMIT 1;
  RETURN v_team_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_team_id() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_team_id() TO anon, authenticated;

-- Permissive policies are OR'd, so this stacks on top of the existing
-- students_select_policy (self + admin/manager) and adds team visibility.
CREATE POLICY students_read_teammates_policy
ON public.students
FOR SELECT
USING (
  team_id IS NOT NULL
  AND team_id = public.get_my_team_id()
);
