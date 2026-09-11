// Subscription-only drinks: whatever Square files under these categories.
// They're offered on the subscribe page only -- never on the order page, the
// public menu, or the menu board. process-payment enforces the same rule on
// the server; it can't load this file, so it keeps its own copy of the names.
//
// Loaded as a plain script; everything below is a global, matching the rest
// of the site.

const SUBSCRIPTION_EXCLUSIVE_CATEGORY_NAMES = ['birdhouse roost exclusive', 'birdhouse eyrie exclusive'];

/** The Square category ids of the exclusive categories, from square_categories rows. */
function subscriptionExclusiveCategoryIds(categories) {
  return new Set((categories || [])
    .filter(c => SUBSCRIPTION_EXCLUSIVE_CATEGORY_NAMES.includes(String(c.name || '').trim().toLowerCase()))
    .map(c => c.square_id));
}

function isSubscriptionExclusive(item, exclusiveIds) {
  return (item.square_category_ids || []).some(id => exclusiveIds.has(id));
}
