# The Birdhouse — Setup Guide

## What You'll End Up With
- A live website hosted on GitHub Pages (free)
- A Google Sheet that automatically captures every order
- A "Delivery Run" tab that acts as your daily checklist
- Automatic confirmation emails sent to customers
- Square handling all payments

---

## STEP 1 — Google Sheet + Apps Script

1. Go to **sheets.google.com** and create a new blank spreadsheet
2. Name it something like **The Birdhouse Orders**
3. Click **Extensions → Apps Script**
4. Delete all the code in the editor (the `function myFunction()` block)
5. Open the **Code.gs** file from this folder and copy everything
6. Paste it into the Apps Script editor
7. Click **Save** (floppy disk icon or Ctrl+S)
8. In the editor, select the function **setupSheets** from the dropdown and click **Run**
   - This creates your Orders and Delivery Run tabs automatically
   - Approve any permissions it asks for
9. Now deploy it:
   - Click **Deploy → New Deployment**
   - Click the gear icon next to "Type" and select **Web App**
   - Description: `Birdhouse v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**
10. **Copy the Web App URL** — you'll need it in Step 3

---

## STEP 2 — Square Payment Links

1. Log into your **Square Dashboard** at dashboard.squareup.com
2. Go to **Online → Payment Links**
3. Create 3 payment links, one per tier:
   - **Perch** — set price and description
   - **Nest** — set price and description
   - **Eagle's Nest** — set price and description
4. Copy each link URL — you'll need them in Step 3

---

## STEP 3 — Configure Your Website

1. Open **birdhouse.html** in a web browser
2. Scroll to the bottom and click **⚙ Store Admin**
3. Fill in:
   - Pricing and Square links for each tier
   - Tier descriptions / perks
   - Delivery days and times
   - Your drink menu (one item per line)
   - The **Google Apps Script URL** from Step 1
4. Click **Save Changes**

---

## STEP 4 — GitHub Pages (Free Hosting)

1. Go to **github.com** and create a free account if you don't have one
2. Click **+** → **New repository**
3. Name it: `birdhouse` (or whatever you like)
4. Set it to **Public**
5. Click **Create repository**
6. Click **uploading an existing file**
7. Drag and drop BOTH files:
   - `birdhouse.html`
   - `logo.png`
8. Click **Commit changes**
9. Go to **Settings → Pages**
10. Under "Source" select **Deploy from branch**
11. Branch: **main**, folder: **/ (root)**
12. Click **Save**
13. Wait ~2 minutes, then your site will be live at:
    `https://YOUR-USERNAME.github.io/birdhouse/birdhouse.html`

> **Tip:** To make the URL cleaner, rename `birdhouse.html` to `index.html` before uploading — then the URL becomes just `https://YOUR-USERNAME.github.io/birdhouse/`

---

## STEP 5 — Test Everything

1. Visit your live site
2. Select a tier and fill out the form with your own info
3. Submit — you should:
   - Be redirected to the Square payment link
   - Receive a confirmation email
   - See a new row appear in your Google Sheet's **Orders** tab
   - See the **Delivery Run** tab update

---

## Daily Use — Delivery Checklist

Each morning before deliveries:
1. Open your Google Sheet
2. Go to the **Delivery Run** tab
3. Click **Extensions → Apps Script**
4. Run the **resetDeliveryChecklist** function to reset all checkboxes
5. Print the sheet or pull it up on a phone/tablet for your delivery runner

As orders are delivered, update the ☐ to ✓ manually in the sheet.

---

## Making Updates

**To update pricing, menu, or Square links:**
→ Go to your live site → click ⚙ Store Admin → make changes → Save

**To pause or cancel a subscription:**
→ Open your Google Sheet → find the customer in the Orders tab → change their Status column from `Active` to `Paused` or `Cancelled` → the Delivery Run sheet will update automatically

**To add a new customer manually:**
→ Add a row directly in the Orders sheet

---

## Files in This Folder

| File | Purpose |
|------|---------|
| `birdhouse.html` | Your website — upload to GitHub |
| `logo.png` | Your logo — upload to GitHub alongside the HTML |
| `Code.gs` | Google Apps Script — paste into Apps Script editor |
| `SETUP.md` | This guide |
