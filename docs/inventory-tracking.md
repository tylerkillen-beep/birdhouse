# Inventory Tracking — Setup and Roadmap

The goal: every sale records what it used, inventory counts itself down, and the
site tells you what to order before you run out. This is being built in
phases. **Usage is set up and deliveries add stock correctly; app orders record
what they use, and so do register sales and subscription drinks; each can
deduct once you switch it on.**

| Phase | What it does | Status |
|---|---|---|
| 1. Usage setup | Links every sale to the inventory it uses | Done |
| 1b. Receiving | Receipts match themselves; deliveries add the right amount | Done |
| 2. App orders | Paid app orders deduct stock; cancelled ones put it back | Built — run the migration, then flip the switch |
| 3a. Register | In-person and Square Online sales deduct too | Built — run the migration, then flip the switch |
| 3b. Subscriptions | Subscription drinks deduct when delivered | Built — run the migration, then flip the switch |
| 4. Forecasting | Days of stock left, "order by" dates, a Needs Ordering list | Planned |

---

## How a sale's usage is worked out

One sale of a menu item uses the sum of:

1. **Its recipe's build steps.** Cup, coffee machine drink and flavor, beverage
   pour, packet, syrups, boba, toppings. Each distinct option ("Lime", "Cold")
   is linked to inventory **once**, and every recipe using it picks the link up.
   - Syrups are linked **per pump**. A recipe saying "Lime (3 pumps)" uses three
     times the link; plain "Lime" means the usual 2 pumps.
   - Packets are linked **per full packet**. Half and quarter packets use half
     and a quarter.
   - Everything else is **per drink**.
2. **The menu item's own "Always uses" list.** Coffee and food have no recipe,
   so this is where "a cookie uses 1 cookie" or "a latte uses a hot cup and
   8 oz of milk" goes. It adds to a recipe too, if an item has one.
3. **Each add-on the customer picked** — a pump of vanilla, oat milk, boba.
   Custom coffees are counted almost entirely from these.

A menu item finds its recipe by name, the way the Recipe Sheet does. When the
names differ (Square says "Sunset Refresher", the recipe says "Sunset"), pick
the recipe on the item's row in Usage Setup.

All of this is one database function, `menu_item_usage()`. The Usage Setup
screen previews it, and phase 2 will deduct with it, so the preview is exactly
what will come off the shelf.

### Units

Every link is written in the inventory item's **recipe unit** (pump, fl oz,
each) — the same unit receipts price it in. Students count in a different unit
(bottles, sleeves, gallons), so each item also needs a **conversion**: how many
recipe units are in one counted unit. A bottle of syrup = 32 pumps; a sleeve of
cups = 50 each.

If a receipt already set an item's recipe unit to `fl oz`, keep it and link
syrups in fl oz per pump (e.g. 0.25) rather than switching the unit to `pump` —
switching it would make the stored receipt cost mean the wrong thing.

---

## Setting it up

1. Run `supabase/migrations/20260911_inventory_usage_setup.sql` in the Supabase
   SQL editor. Do this **before** merging the site change — the new screen and
   the inventory form both need its columns.
2. Open **Admin → Usage Setup**. The four tiles at the top count what's left.
   Tick **Only what needs setup** to hide everything that's done. A good order:
   1. **Recipe Options** — link each cup, syrup, boba, etc. once.
   2. **Add-ons** — link each modifier. Mark the ones that use nothing
      ("Light ice") with **Uses no stock**.
   3. **Menu Items** — add **Always uses** for coffee and food, fix any recipe
      that didn't match by name, and mark things like gift cards
      **Uses no stock**.
   4. **Conversions** — fill in the recipe units per counted unit for every
      item that's linked.
   **Suggested links.** Each unlinked recipe option, add-on, and stand-alone
   item (a cookie) shows a dashed **Suggested** line: the inventory item whose
   name matches best (`lib/usage-suggest.js`), with a starting amount when its
   unit makes that obvious — a syrup pump is 1 when the item is counted in
   pumps, a cup is 1 each. Press **Accept**, change the amount first, or press
   **Not this** and link by hand. **Accept all** on each tab links every
   suggestion whose amount was worked out; ones that still need an amount (milk
   in fl oz, boba in oz) are left for you. Nothing is saved until you accept.
3. When the first tile reads `N/N` — every item on the menu ready — phase 2's
   numbers can be trusted.

"Uses no stock" only quiets the checklist. Anything that *is* linked is still
counted.

---

## Receiving deliveries

Run `supabase/migrations/20260912_receiving.sql` first, then deploy the updated
`parse-receipt` function.

**Uploading a receipt** (Admin → Purchases). The parser now matches each line
to an inventory item while it reads, using the inventory list and every match
confirmed on a past receipt. Each line shows where its match came from — "✓
Matched from a past receipt", "Suggested — …", or nothing when it's unsure — and
a **Counts as** field: how many of the item's counted units one purchase adds
(a 4-pack of bottles = 4). Check those, save, and the matches and pack sizes are
remembered for the next receipt with the same wording.

If the delivery is already here, tick **It's already here** and the Confirm
Delivery screen opens right after saving.

**When boxes arrive** (Admin → Purchases, or Manager → Deliveries). Press
**Confirm Arrival** / **It Arrived** and enter what actually came in. Each line
adds *arrived × counts as* to the count, in one step, and logs it as a restock.
Anything short leaves the order **partial**, still on the list to receive the
rest.

**When a box beats the receipt.** A manager presses **Report It** on the
Deliveries page. It shows up for the admin as **needs receipt** (and on the
Purchases badge). Press **Upload Its Receipt**; the upload attaches to that
delivery instead of making a second order, and goes straight to confirming it.

The Purchases badge counts deliveries needing a receipt plus orders past their
expected date that nobody has confirmed. The manager Deliveries badge counts
orders due by today.

### Checking it in SQL

```sql
select m.name as menu_item, i.name as uses, u.amount, i.base_unit, u.detail
from public.menu_item_usage_preview u
join public.menu_items m on m.id = u.menu_item_id
join public.inventory  i on i.id = u.inventory_id
order by m.name;
```

What one custom order uses, add-ons included (modifier ids are Square catalog
ids, as stored in `orders.cart_items[].selectedModifiers[].catalogObjectId`):

```sql
select * from public.menu_item_usage('<menu item id>', array['<modifier square id>']);
```

---

## Automatic deduction (app orders)

Run `supabase/migrations/20260925_inventory_deduction.sql` in the SQL editor.

Every website order that is **paid** (or preparing, ready, delivered) records what
it used in `order_inventory_usage`: each cart line's recipe and Always-uses
links, plus the add-ons the customer picked, times the quantity. A **cancelled**
or refunded order puts back exactly what was taken. Sticker orders are skipped.

Whether the count itself moves is the switch at the top of **Admin → Usage
Setup**. It starts **off**, so nothing changes until you decide:

1. Finish Usage Setup for the important items (cups, milk, coffee, syrups,
   cookies), with conversions filled in.
2. Bring their counts in Inventory up to date. Deduction starts from whatever
   the count says today.
3. Press **Turn on**. From then on each paid order lowers the counts.

Rules worth knowing:

- Lowering stops at 0, so a stale count never goes negative. The full usage is
  still recorded, so history and forecasts stay right.
- An inventory item with no **conversion** is recorded but not deducted.
- A menu item with no links uses nothing yet, so the count is optimistic until
  Usage Setup covers it. **Hot vs iced isn't distinguished**: an item uses the
  same links either way (an add-on can carry the difference).
- The deduction can never stop an order. If it fails, the order goes through
  and a warning is logged.
- **Rebuild usage history** re-works what past orders used from today's setup,
  without touching counts. Run it after Usage Setup improves, so the manager
  page's "Used · 7 / 30 days" and later the forecast see the right past.
  Anything that really came off the count while the switch was on stays.

The manager Inventory cards show **Used · 7 days** and **Used · 30 days** from
this record, replacing the old Used and Variance numbers that guessed from
recipe names and mixed units.

```sql
-- What recent orders took, item by item:
select o.created_at, o.drink_name, i.name, u.base_amount, i.base_unit, u.applied_amount, i.unit
from public.order_inventory_usage u
join public.orders o on o.id = u.order_id
join public.inventory i on i.id = u.inventory_id
order by u.sold_at desc limit 50;

-- What one order would use:
select i.name, u.base_amount, i.base_unit
from public.order_usage('<order id>') u join public.inventory i on i.id = u.inventory_id;
```

---

## Register sales

Run `supabase/migrations/20260925_register_sales_deduction.sql` (after the app
orders one).

`sync-square-sales` copies register and Square Online sales into
`square_sale_lines` every 15 minutes. It already leaves out the website's own
payments, so an app order is never counted twice. Each new line is matched to
its menu item (the Square item behind the variation, then the name it was rung
up as) and its usage is worked out the same way as for app orders: recipe and
Always-uses links plus the add-ons rung up, times the quantity.

**Register sales** has its own switch beside App orders in Usage Setup, and it
works the same way: off until you turn it on. The register has one difference.
The sync also copies years of past sales, so **only sales closed after you turn
the switch on come off the count**; older ones are recorded for history only.

- Nothing in the edge function changed. Only sales from the last two days are
  worked out as they arrive; older lines come in through **Rebuild usage
  history**, which now also walks register history in batches (it can take a
  few minutes and shows how many lines are left).
- A sale can arrive before Square's item behind it is looked up. The match is
  retried when the sync learns that item.
- The switch card counts register lines from the last 30 days that matched no
  menu item. To see which, run the second query at the bottom of the migration:
  usually an item that isn't synced or was renamed in Square.
- **Refunds aren't restored** (the sync copies what was sold, not returns), and
  custom amounts with no item use nothing.
- As with app orders, a register item with no Usage Setup links deducts nothing.

The manager Inventory cards' **Used** numbers add app orders and register sales
together (`inventory_usage_history`).

---

## Subscription drinks

Run `supabase/migrations/20260925_subscription_drinks_deduction.sql` (after the
register one).

A subscription drink is not an order: the weekly charge already paid for it, and
staff closing it out in the Order Queue is what's recorded, in
`subscription_deliveries`. That's the moment its usage is worked out, with the
same rules as every other channel: the drink's recipe and Always-uses links plus
the add-ons in the slot, one drink each. The drink is the one the slot held
when it was closed out.

**Subscription drinks** has its own switch in Usage Setup, off until you turn it
on. Drinks closed out before that are recorded for history only.

- Marking a drink **delivered** takes its usage off; putting it back on the queue
  (or marking it cancelled) puts it back.
- **Rebuild usage history** also redoes past subscription drinks.

### Weekly cookies

Run `supabase/migrations/20260925_subscription_drinks_deduction_cookies.sql`
after the one above.

A plan's **cookies per week** are shared out across the subscription's drink
slots, so each delivery knows what it carries: with 5 drinks and 2 cookies a
week, slots 1 and 2 carry one cookie each; with 3 drinks and 5 cookies, slots 1
and 2 carry two and slot 3 carries one. It goes by slot, not date, so a delivery
moved by a closure keeps its cookie.

- The **Order Queue card** says "Include N cookies with this delivery".
- Pick the cookie under **Usage Setup → Cookie included with subscription
  plans**. Marking the delivery delivered then records those cookies as used
  (and takes them off the count when Subscription drinks is on); putting it
  back or cancelling it returns them. Until one is picked the card still tells
  staff to include it, but the count doesn't move.
- The count is snapshotted when the delivery is closed out, so a later plan
  change doesn't rewrite what went out that day. Deliveries closed out before
  this migration carry none.
- It's one cookie for every plan. If subscribers get an assortment, pick the one
  that best stands for it.

The manager Inventory cards' **Used** numbers now add app orders, register sales
and subscription drinks (`inventory_usage_history`).

---

## Known gaps, for later phases

- **Legacy `recipe_ingredients` rows** still count toward usage (except syrup
  rows a recipe has replaced with its Syrups checklist). The recipe form no
  longer edits them.
