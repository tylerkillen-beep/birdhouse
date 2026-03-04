# Birdhouse Update Packages (GitHub + Supabase)

This file separates updates into two packages so you can merge frontend/app changes without automatically bundling database and edge-function changes.

## Package A — GitHub code commit (safe app/UI updates)

Use this package when you want to push app code to GitHub.

### Include in GitHub commit
- `admin/index.html`

### Current change in this package
- Admin Menu button label updated to **"Sync Square Catalog"**.
- Admin menu sync now calls your existing Supabase function endpoint:
  - `https://ljukrhneikqbabcmcpet.supabase.co/functions/v1/sync-catalog`
- Clarification: `sync-catalog` is the endpoint currently used by the admin UI. The repo file
  `supabase/functions/sync-square-menu/index.ts` is a separate/new function implementation and
  is **not** required for the UI-only sync button wiring.
- Sync success message supports either response shape:
  - `updated` + `inserted`
  - or `summary.updated` + `summary.newItems`

### Do NOT include (if you want UI-only merge)
- `supabase/migrations/*`
- `supabase/functions/*`

---

## Package B — Manual Supabase changes (run in Supabase dashboard)

Use this package when you want to apply backend changes directly in Supabase.

### SQL (Supabase SQL Editor)
Run these migration files in order:
1. `supabase/migrations/20260304_fix_recursive_students_policies.sql`
2. `supabase/migrations/20260305_fix_admin_related_rls_policies.sql`

### Edge Function updates (Supabase Edge Functions)
If you want Square sync backend logic from repo, use file:
- `supabase/functions/sync-square-menu/index.ts`

If your project already has a working `sync-catalog` function in Supabase, keep using that as
your canonical function and treat `sync-square-menu` as optional unless you intentionally migrate.

You can copy/paste function code into Supabase Edge Function editor (or deploy through your normal process).

---

## Recommended workflow going forward

1. **PR 1 (GitHub UI/App only):** only app files like `admin/*.html`, `student/*.html`, etc.
2. **PR 2 (Supabase backend only):** migrations and edge functions.
3. In PR descriptions, always include:
   - "GitHub package files"
   - "Supabase manual package files"

This keeps merges predictable and prevents accidental DB/function changes from riding along with UI fixes.
