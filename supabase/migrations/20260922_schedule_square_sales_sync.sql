-- Run sync-square-sales on a schedule.
--
-- Until now the sync only ran when a staff member pressed "Sync now" on the
-- Item Lookup tab, so register sales reached the database in irregular lumps
-- -- and the lobby banner's order count, which adds register sales to website
-- orders, was only ever as current as the last press.
--
-- The function was already built for a scheduler: it accepts a CRON_SECRET in
-- an x-cron-secret header alongside the staff button's JWT (see isAllowed in
-- supabase/functions/sync-square-sales/index.ts).
--
-- Run the steps below in order, in the SQL editor. Step 2 happens in the
-- dashboard, so this file is not runnable start to finish in one go.

-- ── 1. Extensions ───────────────────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 2. The shared secret ────────────────────────────────────────────────────
-- Generate it inside the database so it is never typed anywhere, keep it in
-- Vault so the scheduled job holds a lookup rather than the value itself, then
-- read it once to paste into Supabase Dashboard -> Edge Functions -> Secrets
-- as CRON_SECRET. It must match exactly, or every run comes back 401.
--
--   select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'sync_square_cron_secret');
--   select decrypted_secret from vault.decrypted_secrets where name = 'sync_square_cron_secret';

-- ── 3. The schedule ─────────────────────────────────────────────────────────
-- Every 15 minutes, 11:00-21:45 UTC, weekdays. pg_cron runs on UTC, so that
-- window is 6:00am-4:45pm in summer and 5:00am-3:45pm in winter -- either way
-- it covers the whole school day without polling Square through the night.
--
-- Nothing is lost outside the window. Each run copies everything closed since
-- synced_through, so Monday's first run picks up any weekend sale; it arrives
-- late rather than not at all.
--
-- timeout_milliseconds is pg_net's own wait, not the function's. The function
-- stops starting new work after 30s (TIME_BUDGET_MS) and a run cut short
-- resumes where it left off, so an occasional slow run is harmless.
select cron.schedule(
  'sync-square-sales',
  '*/15 11-21 * * 1-5',
  $job$
    select net.http_post(
      url     := 'https://ljukrhneikqbabcmcpet.supabase.co/functions/v1/sync-square-sales',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-secret', (select decrypted_secret
                                       from vault.decrypted_secrets
                                      where name = 'sync_square_cron_secret')
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);

-- ── 4. Check it ─────────────────────────────────────────────────────────────
-- After the next quarter hour, last_run_at should be minutes old and
-- last_error null. A 401 in last_error means the Vault secret and the
-- CRON_SECRET in the dashboard don't match.
--
--   select jobid, jobname, schedule, active from cron.job where jobname = 'sync-square-sales';
--   select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'sync-square-sales') order by start_time desc limit 5;
--   select synced_through, backfill_done, last_run_at, last_error from square_sales_sync;
--
-- To stop it:  select cron.unschedule('sync-square-sales');
