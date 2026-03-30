-- Canvas LMS integration config
-- Stored as a single JSON blob in store_config under key 'canvas_config'
-- Shape: {
--   domain: string,           e.g. "nixa.instructure.com"
--   course_id: string,        Canvas course ID
--   manager_assignment_id: string,  Canvas assignment ID for manager scores
--   peer_assignment_id: string,     Canvas assignment ID for peer evaluations
--   manager_points: number,   Max points on the Canvas manager assignment (default 100)
--   peer_points: number       Max points on the Canvas peer eval assignment (default 100)
-- }

INSERT INTO store_config (key, value)
VALUES ('canvas_config', '{
  "domain": "",
  "course_id": "",
  "manager_assignment_id": "",
  "peer_assignment_id": "",
  "manager_points": 100,
  "peer_points": 100
}'::jsonb)
ON CONFLICT (key) DO NOTHING;
