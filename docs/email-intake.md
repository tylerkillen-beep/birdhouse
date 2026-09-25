# Email intake — orders from forwarded emails

Instead of uploading a receipt for every order, forward the Amazon and Walmart
order emails and the site reads them.

```
Amazon / Walmart email ─► your Gmail inbox ─► Apps Script (every 10 min)
                                              └─► ingest-order-email function
                                                  └─► Admin ▸ Purchases
```

For each email the function works out what kind it is and what to do:

| Email | What happens |
|---|---|
| Order confirmation, or a business-office approval | Attaches to the order you placed from **Needs Ordering** (fills in its order number, date and expected arrival). If there isn't one, creates a new pending order. |
| Shipping notice | Updates the order's expected arrival. |
| Delivered notice | Adds a note to the order. |
| Cancelled | Removes the order, if nothing on it has arrived. |
| Anything else (deals, account notices, returns) | Ignored. |

**Stock never moves from an email.** Counts only change when a manager confirms an
arrival, as before. A wrong reading costs a click to fix, not a wrong count.

Orders it isn't sure of show **needs review** in Admin → Purchases:
a line it couldn't match to inventory, a pack size it couldn't read, or an email that
lists fewer items than the order has. Press **Review**, pick the items, say how many
one purchase adds, and save. Every match you confirm is remembered, so the same
product matches itself next time. **Purchases → Email Log** shows every email the
function saw and what it did, for tracing a missing order.

## One-time setup

**1. Run the migration.** `supabase/migrations/20260926_email_intake.sql` in the
Supabase SQL editor.

**2. Make a secret.** Any long random string (32+ characters). In Supabase →
Edge Functions → Secrets, add `INTAKE_SECRET` with that value. Keep a copy for step 5.

**3. Deploy the function.** `supabase/functions/ingest-order-email`, with **JWT
verification off** (the script has no Supabase login; the secret is the gate).
`supabase/config.toml` already says so if you deploy with the CLI. It uses the same
`ANTHROPIC_API_KEY` as receipt uploads.

**4. Forward the emails to one Gmail inbox.** Use an inbox you can run Apps Script in
(a personal or a new dedicated Gmail — some school accounts block Apps Script).

- **Amazon (your district account):** Gmail → Settings → *Forwarding and POP/IMAP* →
  *Add a forwarding address*, confirm the code it emails, then create a filter
  (*Settings → Filters*) for `from:amazon.com` → *Forward it to* that address.
  Amazon Business approval emails come from Amazon too, so they're included.
- **Walmart:** whoever owns the Walmart account does the same with `from:walmart.com`.
  A one-off "Fwd:" of a single email works too.

**5. Set up the script in the receiving inbox.**

1. Go to <https://script.google.com>, *New project*, and paste in
   [`docs/email-intake/gmail-forwarder.gs`](email-intake/gmail-forwarder.gs).
2. *Project Settings* (gear) → *Script Properties* → add `INTAKE_SECRET` with the
   value from step 2.
3. Choose the function `install` and press *Run*. Approve the permissions (it reads
   your Gmail and calls the function). It creates the label **Birdhouse Orders** and a
   10-minute timer.

**6. Label what to send.** In the receiving inbox, create a filter that applies the
label **Birdhouse Orders** to those emails — for example `from:(amazon.com OR
walmart.com)`, *Apply the label*, and if you like *Skip the Inbox*. Manual forwards
from yourself need the label added by hand, or a filter on `subject:(Fwd:)`.

**7. Try it.** Forward one real order email. Within 10 minutes (or run
`sendOrderEmails` by hand in the script editor) it appears under Admin → Purchases →
**Email Log**, and the order under All.

## Things to know

- **The emails are read by Claude**, the same reader as receipt uploads, so their
  contents (items, prices, and any delivery address in the email) are sent to it. Only
  forward order emails, not your whole inbox.
- **Amazon Business approval emails are incomplete.** The one from 2026-09-23 said "Items
  in order 7" but listed three, and combined four order numbers. The site notices (the
  listed items come to well under the total) and marks the order **needs review**
  instead of trusting it. The order-confirmation emails Amazon sends for each order
  are more complete; if you can get those forwarded too, they match the same order by
  its number.
- **A new order and one you placed from Needs Ordering are matched** when they share
  items and there's exactly one candidate. If two placed orders would both fit, it
  creates a separate order rather than guess — check for a duplicate under Purchases.
- Two emails about the same order (approval, confirmation, shipping) are recognised by
  order number, so they don't create two orders.
- If the reader is busy or down, the script just tries the email again 10 minutes
  later. An email it can't read at all is logged as an error rather than retried
  forever.
