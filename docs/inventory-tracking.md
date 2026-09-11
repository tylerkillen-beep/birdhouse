# Inventory Tracking — Setup and Roadmap

The goal: every sale records what it used, inventory counts itself down, and the
site tells you what to order before you run out. This is being built in four
phases. **Phase 1 is the setup — nothing deducts stock yet.**

| Phase | What it does | Status |
|---|---|---|
| 1. Usage setup | Links every sale to the inventory it uses | **This one** |
| 2. App orders | Paid app orders deduct stock; cancelled ones put it back | Next |
| 3. Register + subscriptions | In-person Square sales and subscription drinks deduct too | Planned |
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
3. When the first tile reads `N/N` — every item on the menu ready — phase 2's
   numbers can be trusted.

"Uses no stock" only quiets the checklist. Anything that *is* linked is still
counted.

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

## Known gaps, for later phases

- **The manager page's "Used" and "Variance" numbers** still come from the old
  name-guessing code and mix units. Phase 2 replaces them.
- **Receiving a purchase order** adds received quantity (purchased units, e.g.
  a 4-pack) straight onto the count (bottles). With `pack_size` and the new
  conversion both known, phase 2 can convert it properly.
- **Register sales** carry a Square variation id; `sync-catalog` only stores an
  item's first variation, so multi-variation items (Hot/Iced sizes) will need
  mapping in phase 3.
- **Legacy `recipe_ingredients` rows** still count toward usage (except syrup
  rows a recipe has replaced with its Syrups checklist). The recipe form no
  longer edits them.
