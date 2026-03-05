# 🦅 The Birdhouse — Full Platform

A dual-portal web platform for the Nixa Eagles coffee business.

---

## File Structure

```
birdhouse/
├── index.html              ← Landing page (choose your portal)
├── supabase-config.js      ← Shared Supabase credentials
├── SUPABASE_SETUP.sql      ← Run this in Supabase first!
│
├── customer/
│   ├── index.html          ← Customer login/signup
│   └── dashboard.html      ← Customer dashboard (orders, loyalty, subscriptions)
│
└── student/
    ├── index.html          ← Student staff login
    └── dashboard.html      ← Team Hub (schedule, inventory, sales, weekly summary)
```

---

## Setup Instructions

### Step 1: Supabase Database
1. Go to your Supabase dashboard → **SQL Editor**
2. Copy and paste the contents of `SUPABASE_SETUP.sql`
3. Click **Run**
4. This creates all 5 tables with proper security rules

### Step 2: Create Student Accounts
Student accounts **cannot self-register** (by design). You (the admin) create them:
1. Go to Supabase → **Authentication → Users → Add User**
2. Enter their email and set a temporary password
3. After creating, go to the user's record and add this to **User Metadata**:
```json
{
  "first_name": "Jane",
  "last_name": "Doe",
  "role": "student"
}
```
4. For admin access, set `"role": "admin"` instead

### Step 3: Deploy to Vercel
1. Push this repository to GitHub.
2. In Vercel, click **Add New → Project** and import this repo.
3. Keep defaults (static site, no build command required) and click **Deploy**.
4. After deploy, your app will be live at `https://<your-project>.vercel.app/`.

### Step 4: Configure Supabase Auth Redirects (Required)
In Supabase → **Authentication → URL Configuration**:
1. Set **Site URL** to your production Vercel URL (or custom domain).
2. Add these **Redirect URLs**:
   - `https://<your-project>.vercel.app/customer/index.html`
   - `https://<your-project>.vercel.app/customer/dashboard.html`
   - `https://<your-project>.vercel.app/student/index.html`
3. If you connect a custom domain, add matching redirect URLs for that domain too.

---

## User Roles

| Role | Can Do |
|------|--------|
| `customer` | Sign up themselves, order drinks, view loyalty points, see their subscription |
| `student` | View their schedule, update inventory, see sales data, submit weekly summaries |
| `admin` | Everything students can do, plus view ALL schedules and summaries |

---

## Features Built

### Customer Portal
- ✅ Self-registration (sign up with name, email, room)
- ✅ Login / logout
- ✅ Loyalty points display
- ✅ Order history
- ✅ Subscription status

### Student Team Hub  
- ✅ Secure login (admin-created accounts only)
- ✅ Weekly schedule view
- ✅ Inventory management (view, update quantities, add items)
- ✅ Sales data & charts
- ✅ Weekly summary submission form
- ✅ Past summaries history

---

## Coming Next
- Customer ordering (with Square integration)
- Schedule builder for admins
- Loyalty point redemption
- Push notifications for deliveries
