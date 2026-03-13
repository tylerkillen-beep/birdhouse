# Square receipts for card transactions: options and implementation plan

This project currently charges cards via `POST /v2/payments` in `supabase/functions/process-payment` and already attempts to trigger Square email receipts by sending `buyer_email_address` on the payment request.

## What happens if you push this right now?

If you only push the documentation changes from this PR:

- **Nothing changes in production behavior.**
- Checkout still uses direct `v2/payments` charging in `process-payment`.
- Receipt behavior remains exactly what your Square account/location currently does today.

This file is a **runbook** for the team: it explains what to verify first and how to implement a supported invoice-based fallback if transaction receipts still do not send.

## Why this file exists

The team asked whether Invoices API is a real alternative for a "collect payment then email receipt" flow. This document is intentionally a planning/implementation guide so a future code PR can be executed in a controlled way (toggle-based rollout, schema updates, webhook handling, and loyalty correctness).

## 1) First, verify whether transaction receipts can be enabled without invoices

Before introducing invoices, verify these in your Square account/environment:

1. **Environment match**
   - If `SQUARE_ENV=sandbox`, receipt behavior may differ from production.
   - Ensure the access token and location are for the same environment.
2. **Customer email presence**
   - The Edge Function sends `buyer_email_address` from authenticated user email fallback logic.
   - Confirm users placing orders actually have an email on their auth profile.
3. **Location-level receipt settings**
   - In Square Dashboard, confirm digital receipts are enabled for card payments for the location used by `SQUARE_LOCATION_ID`.

If those are correct and receipts still do not send for payments, use the invoice-backed flow below.

## 2) Invoice-backed flow that still fits "collect payment, then send receipt"

If Square won't send receipts for direct payment transactions in your setup, the supported alternative is to process the sale through an **Order + Invoice** flow and let Square own customer emails.

Recommended pattern:

1. Build an order (`CreateOrder`) from the cart.
2. Create a draft invoice (`CreateInvoice`) linked to that order.
3. Set invoice `delivery_method: EMAIL` and recipient email.
4. Publish the invoice (`PublishInvoice`) so Square sends email.
5. Collect payment through invoice payment link (or card-on-file auto-charge if configured).
6. Use invoice/payment webhooks to mark local order state as paid.

> Note: this changes payment UX from "charge card nonce immediately in our function" to "invoice-driven payment". It is the cleanest API-supported email path when payment receipts are unavailable in your transaction setup.

## 3) Migration strategy for this codebase

Current behavior in `process-payment`:

- Charges immediately via `POST /v2/payments`.
- Inserts a paid order in Supabase.

To adopt invoices safely:

### Phase A (low risk): keep current payments, add observability

- Log whether `buyer_email_address` was provided.
- Persist Square payment IDs and any receipt-related IDs/URLs for support auditing.
- Confirm with real production transactions whether Square emails are emitted.

### Phase B (invoice mode toggle)

Introduce an env toggle like `SQUARE_CHECKOUT_MODE`:

- `direct_payment` (today): existing card nonce to `v2/payments`.
- `invoice`: create order + draft invoice + publish, then return invoice URL to frontend.

In `invoice` mode:

1. Edge Function writes local order as `pending_payment`.
2. Function returns `invoice_id` and `public_url`.
3. Frontend redirects user to invoice payment page.
4. Webhook handler updates order to `paid` when invoice/payment succeeds.
5. Loyalty accrual runs only after paid webhook to avoid awarding on abandoned invoices.

## 3.5) Concrete next code changes (when ready)

When you want behavior to actually change, create a follow-up implementation PR that:

1. Adds DB migration for `square_order_id`, `square_invoice_id`, `square_invoice_public_url`, and `payment_status`.
2. Adds `SQUARE_CHECKOUT_MODE` handling in `supabase/functions/process-payment/index.ts`.
3. Adds a new webhook Edge Function for invoice/payment events with signature verification and idempotency.
4. Updates the customer checkout UI to handle invoice redirect/public URL when in `invoice` mode.
5. Adds support/admin visibility for pending vs paid invoice-backed orders.

## 4) Data model additions (recommended)

Add nullable columns on `orders`:

- `square_order_id`
- `square_invoice_id`
- `square_invoice_public_url`
- `payment_status` (`pending_payment`, `paid`, `failed`, `canceled`)

This enables support visibility and robust reconciliation.

## 5) Webhooks to add for invoice mode

Subscribe to relevant Square events (exact event names can vary by API version):

- Invoice published/sent
- Invoice payment made
- Payment updated

Webhook responsibilities:

- Verify Square signature.
- Idempotently upsert by Square IDs.
- Transition local order state.
- Trigger loyalty update only once on successful payment.

## 6) Recommended decision

1. **Try to keep direct payments** if production transaction receipts can be enabled at the location/account level.
2. If not possible, implement the **invoice mode toggle** and move receipt email responsibility to Square Invoices API.

This gives a supported long-term path without relying on undocumented receipt preview URLs.
