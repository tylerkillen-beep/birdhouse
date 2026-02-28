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

### Step 3: Deploy to GitHub Pages
1. Replace the files in your `tylerkillen-beep/birdhouse` repo with all these files
2. Make sure the `customer/` and `student/` folders are uploaded too
3. Your site will be live at: `https://tylerkillen-beep.github.io/birdhouse/`

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
