// Which reviews reach the lobby banner's rotation. Shared by banner.html (what
// it shows) and the admin Reviews page (what it says is showing), so the two
// can't disagree.
//
// reviews.banner_pin is a manual override on top of the automatic rules:
//   true  -> always on the banner (skips the quality filters below)
//   false -> never on the banner
//   null  -> automatic
(function (root) {
  'use strict';

  // Only 4- and 5-star reviews with something written in them reach the
  // wall. Anything longer than this gets cut off by the two-line clamp
  // mid-sentence, which reads worse than not showing it at all.
  var MIN_RATING = 4;
  var MAX_REVIEW_CHARS = 155;
  var MIN_REVIEW_WORDS = 4;
  // How many of the newest automatic picks are in the rotation.
  var AUTO_LIMIT = 40;
  // Reviews typed on a phone are full of :sob:-style shortcodes that the
  // app never renders, so they'd reach the wall as literal colon-words.
  var SHORTCODE = /:[a-z_]+:/i;

  // The automatic rules, ignoring any manual pin.
  function passesAuto(r) {
    if (!(r.rating >= MIN_RATING)) return false;
    var text = (r.review_text || '').trim();
    // A bare "ok" is technically a five-star review and says nothing,
    // and neither does an order shorthand like "diet dp #5". Four words
    // is the line that separates a sentence from a scrap here; it costs
    // the odd good two-word review, which is a fair trade on a wall.
    if (text.length < 8 || text.length > MAX_REVIEW_CHARS) return false;
    if (SHORTCODE.test(text)) return false;
    return text.split(/\s+/).length >= MIN_REVIEW_WORDS;
  }

  // The set of review ids currently in the rotation, given every review.
  function rotationIds(reviews) {
    var ids = new Set();
    var auto = [];
    reviews.forEach(function (r) {
      if (r.banner_pin === true) { if ((r.review_text || '').trim()) ids.add(r.id); }
      else if (r.banner_pin !== false && passesAuto(r)) auto.push(r);
    });
    auto.sort(function (a, b) { return b.created_at < a.created_at ? -1 : b.created_at > a.created_at ? 1 : 0; })
      .slice(0, AUTO_LIMIT)
      .forEach(function (r) { ids.add(r.id); });
    return ids;
  }

  root.BannerReviews = { passesAuto: passesAuto, rotationIds: rotationIds, AUTO_LIMIT: AUTO_LIMIT, MIN_RATING: MIN_RATING };
})(window);
