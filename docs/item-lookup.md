# Item Lookup

Team Hub → Sales Data → **Item Lookup** shows every sale of one item: units,
revenue, month by month, by channel, top customers, popular add-ons, and the
item's recipe. Students, managers and admins can all open it.

## Where the numbers come from

| Channel | Source | Customer name |
| --- | --- | --- |
| Website | `orders` (paid, preparing, ready, delivered; sticker orders excluded) | Always |
| Register / Square Online | `square_sale_lines`, copied from Square by `sync-square-sales` | Only when a customer was attached at checkout |
| Subscription | `subscription_deliveries` marked delivered | Always; no per-drink revenue (plans bill weekly) |

`item_sale_lines` combines them. A sale finds its menu item by the website's
own item id, then the Square item, then the name, so renamed and retired items
still line up. Sales that match no menu item show in search as "Not on menu".

Website payments and subscription charges also exist in Square, but as empty
orders. The sync skips them, so nothing is counted twice.

Not counted: refunds and returns made in Square.

## Setup (once)

1. **Run the migration.** Paste `supabase/migrations/20260917_item_sales_lookup.sql`
   into the Supabase SQL editor and run the whole file.

2. **Deploy the function.** Deploy `supabase/functions/sync-square-sales` with
   **JWT verification off** (same as `charge-subscriptions`). It uses the
   Square and `CRON_SECRET` secrets that already exist.

3. **Find the cron secret** the subscription job already uses:

   ```sql
   select command from cron.job where jobname = 'charge-subscriptions-daily';
   ```

4. **Schedule the sync every 10 minutes.** Replace `<CRON_SECRET>` and run as one line:

   ```sql
   select cron.schedule('sync-square-sales', '*/10 * * * *', $$select net.http_post(url := 'https://ljukrhneikqbabcmcpet.supabase.co/functions/v1/sync-square-sales', headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb, body := '{}'::jsonb)$$);
   ```

The first run starts the history import. Each run copies new sales, then works
backward through older sales two weeks at a time until it reaches the day the
Square location opened. Until the import finishes, the Item Lookup tab says
how far back it has got. **Sync now** on that tab runs a sync on the spot.

## Checking on it

```sql
select * from public.square_sales_sync;
```

`backfill_done` turns true once the full history is in. `last_error` shows why
the most recent run failed, if it did.

```sql
select count(*), min(closed_at), max(closed_at) from public.square_sale_lines;
```

To stop syncing: `select cron.unschedule('sync-square-sales');`
