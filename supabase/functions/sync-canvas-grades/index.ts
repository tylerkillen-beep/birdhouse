// Supabase Edge Function: sync-canvas-grades
// Aggregates weekly manager scores, peer evaluation scores, and/or team product
// performance scores per student and submits them to Canvas LMS via the REST API.
//
// Required Supabase secrets:
//   CANVAS_ACCESS_TOKEN  — Canvas API token (generated in Canvas → Account → Settings)
//
// Canvas config is stored in store_config under key 'canvas_config':
//   { domain, course_id,
//     manager_assignment_id, peer_assignment_id, product_assignment_id,
//     manager_points, peer_points, product_points }
//
// Scoring:
//   Manager: sum(student_scores.score) / sum(rubric.max_points) * manager_points
//   Peer:    avg(peer_evaluations.score received) / 10 * peer_points
//   Product: (team_profit / threshold) capped at 1.0, * product_points
//            team_scores passed from client as [{team_id, score}] where score is 0–10
//
// Students are matched to Canvas users by email via sis_login_id.
//
// Request body: {
//   week_start: string,          "YYYY-MM-DD" (Monday of the target week)
//   type: "manager"|"peer"|"product"|"both"|"all",
//   dry_run?: boolean            if true, compute grades but don't submit to Canvas
//   team_scores?: Array<{ team_id: string; score: number }>   required when type includes "product"
// }
// Accessible by admin or manager only.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

interface CanvasConfig {
  domain: string;
  course_id: string;
  manager_assignment_id: string;
  peer_assignment_id: string;
  product_assignment_id: string;
  manager_points: number;
  peer_points: number;
  product_points: number;
}

interface RubricRow {
  id: string;
  max_points: number;
  active: boolean;
}

interface StudentRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  team_id: string | null;
}

interface ManagerScoreRow {
  student_id: string;
  rubric_id: string;
  score: number;
}

interface PeerEvalRow {
  evaluatee_id: string;
  evaluator_id: string;
  score: number;
}

interface TeamScoreInput {
  team_id: string;
  score: number; // 0–10
}

interface GradeResult {
  student_id: string;
  name: string;
  email: string;
  grade: number;
  canvas_status: "submitted" | "skipped" | "error" | "dry_run";
  canvas_error?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anon || !service) {
      return json({ success: false, error: "Missing Supabase environment variables" }, 500);
    }

    // Authenticate caller
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ success: false, error: "Unauthorized" }, 401);

    const serviceClient = createClient(supabaseUrl, service);

    const ownerEmail = "tylerkillen@nixaschools.net";
    let allowed = (user.email || "").toLowerCase() === ownerEmail;
    if (!allowed) {
      const { data: student } = await serviceClient
        .from("students")
        .select("role")
        .eq("id", user.id)
        .single();
      allowed = !!student && ["admin", "manager"].includes(student.role);
    }
    if (!allowed) return json({ success: false, error: "Forbidden" }, 403);

    // Parse request body
    const body = await req.json();
    const { week_start, type, dry_run = false, team_scores = [] } = body as {
      week_start: string;
      type: "manager" | "peer" | "product" | "both" | "all";
      dry_run?: boolean;
      team_scores?: TeamScoreInput[];
    };

    if (!week_start || !/^\d{4}-\d{2}-\d{2}$/.test(week_start)) {
      return json({ success: false, error: "week_start must be a YYYY-MM-DD date string" }, 400);
    }
    if (!["manager", "peer", "product", "both", "all"].includes(type)) {
      return json({ success: false, error: "type must be 'manager', 'peer', 'product', 'both', or 'all'" }, 400);
    }

    const includesManager = type === "manager" || type === "both" || type === "all";
    const includesPeer = type === "peer" || type === "both" || type === "all";
    const includesProduct = type === "product" || type === "all";

    if (includesProduct && (!team_scores || team_scores.length === 0)) {
      return json({ success: false, error: "team_scores is required when syncing product performance grades" }, 400);
    }

    // Load Canvas config
    const canvasToken = Deno.env.get("CANVAS_ACCESS_TOKEN");
    if (!canvasToken) return json({ success: false, error: "Missing CANVAS_ACCESS_TOKEN secret" }, 500);

    const { data: configRow, error: configErr } = await serviceClient
      .from("store_config")
      .select("value")
      .eq("key", "canvas_config")
      .single();

    if (configErr || !configRow) {
      return json({ success: false, error: "Canvas config not found in store_config" }, 500);
    }

    const cfg = configRow.value as CanvasConfig;
    if (!cfg.domain || !cfg.course_id) {
      return json({ success: false, error: "Canvas config is incomplete. Set domain and course_id in Canvas Settings." }, 400);
    }
    if (includesManager && !cfg.manager_assignment_id) {
      return json({ success: false, error: "manager_assignment_id is not configured in Canvas Settings." }, 400);
    }
    if (includesPeer && !cfg.peer_assignment_id) {
      return json({ success: false, error: "peer_assignment_id is not configured in Canvas Settings." }, 400);
    }
    if (includesProduct && !cfg.product_assignment_id) {
      return json({ success: false, error: "product_assignment_id is not configured in Canvas Settings." }, 400);
    }

    const canvasBase = `https://${cfg.domain}/api/v1`;
    const canvasHeaders = {
      "Authorization": `Bearer ${canvasToken}`,
      "Content-Type": "application/json",
    };

    // Load active rubric (needed for manager + peer scoring)
    const { data: rubricData } = await serviceClient
      .from("score_rubric")
      .select("id, max_points, active")
      .eq("active", true);
    const rubric: RubricRow[] = rubricData || [];
    const rubricMaxTotal = rubric.reduce((sum, r) => sum + (r.max_points ?? 0), 0);

    // Load all students with email and team_id
    const { data: studentsData } = await serviceClient
      .from("students")
      .select("id, first_name, last_name, email, team_id")
      .eq("role", "student");
    const students: StudentRow[] = studentsData || [];

    const managerResults: GradeResult[] = [];
    const peerResults: GradeResult[] = [];
    const productResults: GradeResult[] = [];

    // ── Manager Scores ──────────────────────────────────────────────────────────
    if (includesManager) {
      const { data: scoresData } = await serviceClient
        .from("student_scores")
        .select("student_id, rubric_id, score")
        .eq("week_start", week_start);
      const scores: ManagerScoreRow[] = scoresData || [];

      // Group scores by student
      const scoresByStudent = new Map<string, number>();
      for (const row of scores) {
        scoresByStudent.set(row.student_id, (scoresByStudent.get(row.student_id) ?? 0) + (row.score ?? 0));
      }

      const maxPoints = cfg.manager_points ?? 100;

      for (const student of students) {
        const earned = scoresByStudent.get(student.id) ?? null;
        if (earned === null) {
          managerResults.push({
            student_id: student.id,
            name: `${student.first_name} ${student.last_name}`,
            email: student.email,
            grade: 0,
            canvas_status: "skipped",
            canvas_error: "No manager scores submitted for this week",
          });
          continue;
        }

        const grade = rubricMaxTotal > 0
          ? Math.round((earned / rubricMaxTotal) * maxPoints * 100) / 100
          : 0;

        const result: GradeResult = {
          student_id: student.id,
          name: `${student.first_name} ${student.last_name}`,
          email: student.email,
          grade,
          canvas_status: dry_run ? "dry_run" : "submitted",
        };

        if (!dry_run) {
          const canvasUrl = `${canvasBase}/courses/${cfg.course_id}/assignments/${cfg.manager_assignment_id}/submissions/sis_login_id:${encodeURIComponent(student.email)}`;
          const resp = await fetch(canvasUrl, {
            method: "PUT",
            headers: canvasHeaders,
            body: JSON.stringify({ submission: { posted_grade: grade } }),
          });
          if (!resp.ok) {
            const errText = await resp.text();
            result.canvas_status = "error";
            result.canvas_error = `Canvas API ${resp.status}: ${errText.slice(0, 200)}`;
          }
        }

        managerResults.push(result);
      }
    }

    // ── Peer Evaluations ────────────────────────────────────────────────────────
    if (includesPeer) {
      const { data: peerData } = await serviceClient
        .from("peer_evaluations")
        .select("evaluatee_id, evaluator_id, score")
        .eq("week_start", week_start);
      const peerEvals: PeerEvalRow[] = peerData || [];

      // Mirror the admin UI: for each evaluator sum all their category scores into one
      // composite, then average those composites across evaluators per evaluatee.
      const evalScores = new Map<string, Map<string, number>>();
      for (const row of peerEvals) {
        if (!evalScores.has(row.evaluatee_id)) evalScores.set(row.evaluatee_id, new Map());
        const byEval = evalScores.get(row.evaluatee_id)!;
        byEval.set(row.evaluator_id, (byEval.get(row.evaluator_id) ?? 0) + (row.score ?? 0));
      }

      // Total peer max mirrors admin UI: each rubric category's share of 10 points
      const totalPeerMax = rubricMaxTotal > 0
        ? rubric.reduce((a, r) => a + Math.max(1, Math.round((r.max_points / rubricMaxTotal) * 10)), 0)
        : 10;

      const maxPoints = cfg.peer_points ?? 100;

      for (const student of students) {
        const byEval = evalScores.get(student.id);

        if (!byEval || byEval.size === 0) {
          peerResults.push({
            student_id: student.id,
            name: `${student.first_name} ${student.last_name}`,
            email: student.email,
            grade: 0,
            canvas_status: "skipped",
            canvas_error: "No peer evaluations received for this week",
          });
          continue;
        }

        const composites = Array.from(byEval.values());
        const avgComposite = composites.reduce((a, b) => a + b, 0) / composites.length;
        const grade = Math.round((avgComposite / totalPeerMax) * maxPoints * 100) / 100;

        const result: GradeResult = {
          student_id: student.id,
          name: `${student.first_name} ${student.last_name}`,
          email: student.email,
          grade,
          canvas_status: dry_run ? "dry_run" : "submitted",
        };

        if (!dry_run) {
          const canvasUrl = `${canvasBase}/courses/${cfg.course_id}/assignments/${cfg.peer_assignment_id}/submissions/sis_login_id:${encodeURIComponent(student.email)}`;
          const resp = await fetch(canvasUrl, {
            method: "PUT",
            headers: canvasHeaders,
            body: JSON.stringify({ submission: { posted_grade: grade } }),
          });
          if (!resp.ok) {
            const errText = await resp.text();
            result.canvas_status = "error";
            result.canvas_error = `Canvas API ${resp.status}: ${errText.slice(0, 200)}`;
          }
        }

        peerResults.push(result);
      }
    }

    // ── Product Performance ─────────────────────────────────────────────────────
    if (includesProduct) {
      // Build team_id → score map from client-provided data
      const teamScoreMap = new Map<string, number>();
      for (const ts of team_scores) {
        teamScoreMap.set(ts.team_id, ts.score); // score is 0–10
      }

      const maxPoints = cfg.product_points ?? 10;

      for (const student of students) {
        if (!student.team_id || !teamScoreMap.has(student.team_id)) {
          productResults.push({
            student_id: student.id,
            name: `${student.first_name} ${student.last_name}`,
            email: student.email,
            grade: 0,
            canvas_status: "skipped",
            canvas_error: student.team_id
              ? "Team not included in product scores for this week"
              : "Student has no team assigned",
          });
          continue;
        }

        const rawScore = teamScoreMap.get(student.team_id)!; // 0–10
        const grade = Math.round((rawScore / 10) * maxPoints * 100) / 100;

        const result: GradeResult = {
          student_id: student.id,
          name: `${student.first_name} ${student.last_name}`,
          email: student.email,
          grade,
          canvas_status: dry_run ? "dry_run" : "submitted",
        };

        if (!dry_run) {
          const canvasUrl = `${canvasBase}/courses/${cfg.course_id}/assignments/${cfg.product_assignment_id}/submissions/sis_login_id:${encodeURIComponent(student.email)}`;
          const resp = await fetch(canvasUrl, {
            method: "PUT",
            headers: canvasHeaders,
            body: JSON.stringify({ submission: { posted_grade: grade } }),
          });
          if (!resp.ok) {
            const errText = await resp.text();
            result.canvas_status = "error";
            result.canvas_error = `Canvas API ${resp.status}: ${errText.slice(0, 200)}`;
          }
        }

        productResults.push(result);
      }
    }

    const allResults = [...managerResults, ...peerResults, ...productResults];
    const submitted = allResults.filter(r => r.canvas_status === "submitted").length;
    const errors = allResults.filter(r => r.canvas_status === "error").length;

    return json({
      success: true,
      dry_run,
      week_start,
      type,
      summary: { submitted, errors, dry_run: dry_run ? allResults.length : 0 },
      manager_results: includesManager ? managerResults : undefined,
      peer_results: includesPeer ? peerResults : undefined,
      product_results: includesProduct ? productResults : undefined,
    });

  } catch (err) {
    console.error("sync-canvas-grades error:", err);
    return json({ success: false, error: String(err) }, 500);
  }
});
