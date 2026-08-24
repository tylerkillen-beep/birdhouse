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
- Clarification: `sync-catalog` is the endpoint currently deployed and used by the admin UI.
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

Use `sync-catalog` as the canonical function in this project. Keep `sync-square-menu` in repo only as an optional alternative implementation unless/until you deploy and migrate to it.

You can copy/paste function code into Supabase Edge Function editor (or deploy through your normal process).

---

## Recommended workflow going forward

1. **PR 1 (GitHub UI/App only):** only app files like `admin/*.html`, `student/*.html`, etc.
2. **PR 2 (Supabase backend only):** migrations and edge functions.
3. In PR descriptions, always include:
   - "GitHub package files"
   - "Supabase manual package files"

This keeps merges predictable and prevents accidental DB/function changes from riding along with UI fixes.

---

## 2026-08-24 — Menu Board + Recipe Sheet (Phase 1)

Replaces the Google Slides specials board and the drink-build spreadsheet with two pages on the site, built on top of the existing `recipes` / `recipe_ingredients` tables. Photos for the Menu Board upload to a new Supabase Storage bucket. This is Phase 1 only — menu items still get created in Admin → Menu, and recipes in Admin → Recipes, as two separate steps. A later pass will require a recipe at item-creation time, let specific students manage the menu directly, and calculate item cost from ingredients.

### Package A — GitHub code commit
Include in GitHub commit:
- `board.html` (new) — public Menu Board, no login required, kiosk/TV-style display of available items grouped by category. Specials show a photo + description if one's been uploaded.
- `student/recipe-sheet.html` (new) — login-required staff reference page: one spreadsheet-style table per menu category (Drink / Cup / Ice / Coffee Machine Selection / Syrup(s) / Packet / Beverage Pour / Topping(s)).
- `admin/index.html` — the Recipe modal now has the six build-spec fields above (Cup, Ice, Coffee Machine Selection, Packet, Beverage Pour, Toppings) alongside the existing ingredient list; the Menu Item modal now has a photo upload (uploads to the `menu-images` bucket, stores the public URL on the item); sidebar now links out to the Recipe Sheet and Menu Board.
- `student/dashboard.html`, `manager/index.html` — sidebar links to the new Recipe Sheet and Menu Board pages.

### Do NOT include (if you want UI-only merge)
- `supabase/migrations/20260824_menu_board_recipe_sheet.sql`

---

### Package B — Manual Supabase changes (run in Supabase dashboard)

1. Run `supabase/migrations/20260824_menu_board_recipe_sheet.sql` in the SQL Editor. It adds:
   - `menu_items.image_url`
   - `recipes.cup_type`, `recipes.ice_amount`, `recipes.coffee_machine_selection`, `recipes.packet`, `recipes.beverage_pour`, `recipes.toppings`
   - a public `menu-images` Storage bucket + policies (public read, staff-only write)
2. If your project doesn't allow creating Storage buckets from the SQL Editor, the `insert into storage.buckets ...` statement will simply no-op or error — in that case create the **menu-images** bucket manually in Dashboard → Storage, mark it **Public**, then re-run just the four `storage.objects` policy statements from the migration (or apply the public-read behavior via the bucket's "Public bucket" toggle instead).
3. No RLS changes needed on `recipes` / `recipe_ingredients` — existing policies already let any signed-in user read them, which is what the Recipe Sheet needs.
