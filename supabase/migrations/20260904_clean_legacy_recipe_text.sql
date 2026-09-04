-- Tidy the free text left on recipes from before the build steps became pickers.
--
-- Cup / machine / packet / pour / toppings used to be typed by hand, so the
-- Recipe Sheet was showing "Iced None", "none", "sprite" and "frozen pinnapple"
-- alongside the clean values the dropdowns produce. This normalizes what's
-- already saved; everything entered from here on is picked from a list.
--
-- Safe to run more than once.

-- ── "none" means nothing was chosen ──────────────────────────────────────────
-- The pickers save NULL when nothing is selected and the sheet renders that as
-- an em dash. Leaving the typed word behind would have older rows saying "None"
-- forever while newer ones show "—".
update public.recipes set coffee_machine_selection = null
where coffee_machine_selection is not null
  and (btrim(coffee_machine_selection) = '' or lower(btrim(coffee_machine_selection)) in ('none', 'n/a'));

update public.recipes set packet = null
where packet is not null
  and (btrim(packet) = '' or lower(btrim(packet)) in ('none', 'n/a'));

update public.recipes set beverage_pour = null
where beverage_pour is not null
  and (btrim(beverage_pour) = '' or lower(btrim(beverage_pour)) in ('none', 'n/a'));

-- ── Machine drink is just the drink ──────────────────────────────────────────
-- The cup type supplies the "Iced" prefix now ("Iced Caramel Mocha"), so a
-- stored "iced latte" would otherwise read "Iced iced latte".
update public.recipes set coffee_machine_selection = 'Latte'
where lower(btrim(coffee_machine_selection)) in ('iced latte', 'latte');

-- ── Sprite is Sprite Zero ────────────────────────────────────────────────────
update public.recipes set beverage_pour = 'Sprite Zero'
where lower(btrim(beverage_pour)) = 'sprite';

-- ── Toppings match the checklist's spelling ──────────────────────────────────
-- Only all-lowercase entries get title-cased, so deliberate casing is left
-- alone; "frozen pinnapple" is corrected outright.
update public.recipes
set toppings = (
  select string_agg(fixed, ', ' order by ord)
  from (
    select ord,
      case
        when lower(btrim(v)) in ('frozen pinnapple', 'frozen pineapple') then 'Frozen Pineapple'
        when btrim(v) = lower(btrim(v)) then initcap(btrim(v))
        else btrim(v)
      end as fixed
    from unnest(string_to_array(public.recipes.toppings, ',')) with ordinality as t(v, ord)
    where btrim(v) <> ''
  ) s
)
where toppings is not null and btrim(toppings) <> '';

-- Any recipe left with an empty toppings string has nothing in it.
update public.recipes set toppings = null
where toppings is not null and btrim(toppings) = '';

-- Check the result:
--   select name, cup_type, coffee_machine_selection, packet, beverage_pour, toppings
--   from public.recipes order by name;
