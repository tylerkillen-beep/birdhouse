-- Restore menu_items.category and .available after the 2026-08-28 Square sync
-- reset every item to category 'Coffee' and available = true.
--
-- Source of truth: a snapshot of the live menu read on 2026-08-28, before the
-- sync ran. Keyed on square_item_id, which is unique, so duplicate display
-- names (3x Latte, 3x Mocha, 2x Cookie, 2x Soda, 2x Chai Latte) are unambiguous.
--
-- Run AFTER deploying the fixed sync-catalog, otherwise the next sync undoes it.
-- Does NOT restore is_hot / is_iced -- those were not captured. See notes below.

begin;

-- ── Categories ───────────────────────────────────────────────────────────────
-- Coffee items are already correct (everything was reset to 'Coffee'), so only
-- the three non-Coffee categories need restoring.

update menu_items set category = 'Food'
where square_item_id in ('IFRCGIZEOWSDEPJRNEUIFATP');           -- Cookie

update menu_items set category = 'Soda & Tea'
where square_item_id in (
  'IQ7CJ3AIIBX3PL4YTDFRG66R',  -- Dirty Dr. Pepper
  'JKW4IMYX472JSQJEM4QYEUDR',  -- Cherry Rush
  'KUPDYZQ7N6V5WXSD5WRQGEOZ',  -- Berry Bobaful
  'CDIUHLCAS25Q2BCFBWMZNNTR',  -- Blue Lagoon
  'WEHMUTLS65NO7CQGX3JILMEA',  -- Shark Attack Refresher
  'JY6QIFDOYA3772HIGAOXX3MU',  -- Iced Tea
  'IUJZAXUQTQVHKGXF47WBKAJ7',  -- Special Sunrise
  'FDIJRGJLTOVG7DJSI6ASAFOI',  -- Soda
  'WYWPJMKVL7WGIWMPJIBGOZHS'   -- Fruity Bomb
);

update menu_items set category = 'Specials'
where square_item_id in (
  'OACN224TGNGPWPNEOPM2R33Q',  -- Grogu
  'RVWLS3NUU55ORXWMPDDZV6ZC',  -- Blackberry Cobbler
  'DA2LKC55SYHPWE2VIHONWY2Q',  -- Summertime
  'MINRQ233UCU23BTLOA7DFZVM',  -- This is the Way
  'CI3O2SZ6FDDTQPO7BTLRZNWL',  -- The Dark Side
  'O7HUY7ZAAY42IKLDBMNZVMN5',  -- The Light Side
  'YA4XLHQWFAVDF5ZDO36K65WY'   -- Secret Menu Item
);

-- ── Availability ─────────────────────────────────────────────────────────────
-- 33 of the 47 items were visible before the sync. This re-hides the other 14.
-- Written as "disable these" rather than "enable those" so it can only ever
-- hide an item, never expose one that was meant to stay hidden.

-- Names where every copy was hidden.
update menu_items set available = false
where name in (
  'Bagel',
  'Caramel Delight',          -- 2 rows, both hidden
  'Eagle Energy',
  'Energy Fizz',
  'Four Cents',
  'Midday Blues Eraser',
  'Regular (Black) Coffee',
  'Senior Sendoff',
  'Sweeeeeeet Tea',
  'Test Item'
);

-- Names with two rows where only one was visible: hide the other.
update menu_items set available = false
where name = 'Chai Latte' and square_item_id is distinct from 'YPWZZBJU2S2MC3UXOOIGXKPH';

update menu_items set available = false
where name = 'Cookie' and square_item_id is distinct from 'IFRCGIZEOWSDEPJRNEUIFATP';

update menu_items set available = false
where name = 'Soda' and square_item_id is distinct from 'FDIJRGJLTOVG7DJSI6ASAFOI';

commit;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: Coffee 16, Soda & Tea 9, Specials 7, Food 1 = 33 available.
select category, count(*) as visible
from menu_items
where available = true
group by category
order by category;
