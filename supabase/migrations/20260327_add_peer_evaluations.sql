-- Peer evaluations: students evaluate their teammates weekly
-- Scores are anonymous (evaluator hidden in UI), comments show evaluator name
-- Scaled to out of 10 total (vs manager scores out of ~50)

CREATE TABLE IF NOT EXISTS peer_evaluations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluator_id uuid       NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  evaluatee_id uuid       NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  rubric_id    uuid       NOT NULL REFERENCES score_rubric(id) ON DELETE CASCADE,
  week_start   date       NOT NULL,
  score        numeric    NOT NULL DEFAULT 0,
  comment      text,
  evaluator_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evaluator_id, evaluatee_id, rubric_id, week_start)
);

ALTER TABLE peer_evaluations ENABLE ROW LEVEL SECURITY;

-- Students can see evaluations they submitted, evaluations about them, or admin/manager sees all
CREATE POLICY "peer_eval_select" ON peer_evaluations
  FOR SELECT USING (
    evaluator_id = auth.uid()
    OR evaluatee_id = auth.uid()
    OR public.is_owner_or_staff()
  );

-- Students can only submit evaluations as themselves
CREATE POLICY "peer_eval_insert" ON peer_evaluations
  FOR INSERT WITH CHECK (evaluator_id = auth.uid());

-- Students can only update their own submitted evaluations
CREATE POLICY "peer_eval_update" ON peer_evaluations
  FOR UPDATE
  USING (evaluator_id = auth.uid())
  WITH CHECK (evaluator_id = auth.uid());
