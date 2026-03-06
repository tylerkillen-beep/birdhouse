# Birdhouse Update Packages (GitHub + Supabase)

This file separates updates into two packages so you can merge frontend/app changes without automatically bundling database and edge-function changes.

## Package A — GitHub code commit (safe app/UI updates)

Use this package when you want to push app code to GitHub.

### Include in GitHub commit
- `admin/index.html`

### Current change in this package
- Admin Menu button label updated to **"Sync Square Catalog"**.
- Admin menu sync now calls your existing Supabase function endpoint:
  - `https://ljukrhneikqbabcmcpet.supabase.co/functions/v1/sync-square-menu`
- Clarification: `sync-square-menu` is the single endpoint used by the admin UI and is the canonical sync function for this project.
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
3. `supabase/migrations/20260306_create_plans_table_and_staff_subscriptions_policy.sql` (adds missing `plans` table + plan/subscription policies)

### Edge Function updates (Supabase Edge Functions)
If you want Square sync backend logic from repo, use file:
- `supabase/functions/sync-square-menu/index.ts`

Use `sync-square-menu` as the canonical function and delete/deprecate any old `sync-catalog` deployment to avoid confusion.

You can copy/paste function code into Supabase Edge Function editor (or deploy through your normal process).

---

## Recommended workflow going forward

1. **PR 1 (GitHub UI/App only):** only app files like `admin/*.html`, `student/*.html`, etc.
2. **PR 2 (Supabase backend only):** migrations and edge functions.
3. In PR descriptions, always include:
   - "GitHub package files"
   - "Supabase manual package files"

This keeps merges predictable and prevents accidental DB/function changes from riding along with UI fixes.
