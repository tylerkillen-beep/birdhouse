// Mathews campus rules, shared by every page that shows the menu or takes a
// Mathews order.
//
// The Mathews menu is whatever Square files under the Teacher Menu category.
// Those items are offered to Mathews customers only, and Mathews customers see
// nothing else. Mathews is delivery only, Monday/Wednesday/Friday, at one of
// two fixed times; closed dates come from the same blocked_dates calendar as
// the Birdhouse.
//
// A Mathews soda is built on a base: one pick from the "Teacher Soda" modifier
// list is required and doesn't use up any of a plan's free modifiers.
//
// process-payment and save-card enforce the same rules on the server; they
// can't load this file, so they keep their own copies -- change them together.
//
// Loaded as a plain script; everything below is a global, matching the rest
// of the site.

const MATHEWS_MENU_CATEGORY_NAMES = ['teacher menu'];
const MATHEWS_BASE_MODIFIER_LIST_NAMES = ['teacher soda'];
const MATHEWS_DELIVERY_WEEKDAYS   = [1, 3, 5]; // Date.getDay(): Mon, Wed, Fri
const MATHEWS_DELIVERY_DAY_NAMES  = ['Monday', 'Wednesday', 'Friday'];
const MATHEWS_DELIVERY_TIMES      = ['8:00 AM', '12:00 PM'];

/** The Square category ids of the Mathews menu, from square_categories rows. */
function mathewsMenuCategoryIds(categories) {
  return new Set((categories || [])
    .filter(c => MATHEWS_MENU_CATEGORY_NAMES.includes(String(c.name || '').trim().toLowerCase()))
    .map(c => c.square_id));
}

function isMathewsMenuItem(item, mathewsIds) {
  return (item.square_category_ids || []).some(id => mathewsIds.has(id));
}

/** True for a modifier list (by name) that holds a drink's required base. */
function isMathewsBaseList(list) {
  return MATHEWS_BASE_MODIFIER_LIST_NAMES.includes(String(list?.name || '').trim().toLowerCase());
}

function isMathewsDeliveryDay(date) {
  return MATHEWS_DELIVERY_WEEKDAYS.includes(date.getDay());
}
