// Suggested inventory links for Usage Setup (admin/index.html).
//
// A recipe option ("Lime"), an add-on ("Oat Milk") or a menu item ("Chocolate
// Chip Cookie") is matched to the inventory item it most likely uses, by name,
// with a starting amount when the units make it obvious (a syrup pump is 1 when
// the item is counted in pumps). Only ever a starting guess: the admin sees
// each suggestion and accepts, edits or ignores it, and nothing is saved until
// they do.
//
//   const s = UsageSuggest.suggest({ kind: 'option', type: 'syrup', name: 'Lime', inventory });
//   // -> { inv, score, amount } or null. amount is null when the unit is unclear.
//
// kind: 'option' (a recipe build step, with its type), 'addon', or 'item'.
// Loaded as a plain script; everything is under the UsageSuggest global.

const UsageSuggest = (function () {
  // Words that say what kind of thing it is rather than which one, so "Lime"
  // matches "Lime Syrup" and "Cookies" match "Cookie".
  const FILLER = new Set(['the', 'and', 'of', 'with', 'w', 'a', 'an', 'for', 'fl', 'flavor', 'flavored', 'flavour',
    'syrup', 'pump', 'bottle', 'bag', 'box', 'case', 'pack', 'each']);
  const UNIT_WORDS = { ounce: 'oz', ounces: 'oz', ozs: 'oz' };
  const COUNT_UNITS = /^(each|ea|cup|lid|piece|count|ct|cookie|packet|bag|sleeve|bottle|straw|pump|scoop|serving|item|unit)s?$/;

  function tokens(text) {
    return new Set(
      String(text ?? '').toLowerCase()
        .replace(/([0-9])([a-z])/g, '$1 $2')
        .replace(/([a-z])([0-9])/g, '$1 $2')
        .split(/[^a-z0-9]+/)
        .map(t => UNIT_WORDS[t] || t)
        .map(t => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
        .filter(t => t && !FILLER.has(t))
    );
  }

  const isNumber = t => /^[0-9]+$/.test(t);

  /** How well an inventory name fits: null when it can't be the same thing. */
  function score(want, have) {
    if (!want.size || !have.size) return null;
    // "16 oz" is not "24 oz".
    const wantNums = [...want].filter(isNumber);
    const haveNums = new Set([...have].filter(isNumber));
    if (wantNums.some(n => !haveNums.has(n))) return null;
    const common = [...want].filter(t => have.has(t)).length;
    const coverage = common / want.size;
    if (coverage < 0.75) return null;
    const union = new Set([...want, ...have]).size;
    return coverage * 0.7 + (common / union) * 0.3;
  }

  const isPacket = inv => /^packets?$/.test(String(inv.unit || '').trim().toLowerCase()) || tokens(inv.name).has('packet');

  /** Starting amount, in the item's recipe unit, when the unit makes it plain. */
  function guessAmount(styleType, inv) {
    const b = String(inv.base_unit || '').trim().toLowerCase();
    if (!b) return null;
    if (styleType === 'syrup') {
      if (/^pumps?$/.test(b)) return 1;
      if (/^(fl\.? ?oz|oz|ounces?)$/.test(b)) return 0.25;   // a pump is about a quarter ounce
      return null;
    }
    if (styleType === 'packet') return /^packets?$/.test(b) ? 1 : null;
    if (styleType === 'count') return COUNT_UNITS.test(b) ? 1 : null;
    return null;
  }

  function suggest({ kind, type, name, inventory }) {
    const want = tokens(name);
    if (kind === 'option' && type === 'cup') want.add('cup');
    if (!want.size) return null;

    let best = null;
    (inventory || []).forEach(inv => {
      const have = tokens(inv.name);
      let s = score(want, have);
      if (s == null) return;
      if (kind === 'item') {
        // A menu item is matched whole -- "Cookie" alone shouldn't claim "Chocolate Chip Cookie".
        const common = [...have].filter(t => want.has(t)).length;
        if (common / have.size < 0.75) return;
      }
      const flavorish = inv.category === 'flavors' && !isPacket(inv);
      if (type === 'syrup') s += flavorish ? 0.1 : isPacket(inv) ? -0.3 : 0;
      if (type === 'packet') s += isPacket(inv) ? 0.1 : -0.3;
      if (kind === 'addon' && inv.category === 'flavors') s += 0.05;
      if (!best || s > best.score || (s === best.score && String(inv.name).length < String(best.inv.name).length)) {
        best = { inv, score: s };
      }
    });
    if (!best) return null;

    const style = kind === 'option' && (type === 'syrup' || type === 'packet') ? type
      : kind === 'addon' ? (isPacket(best.inv) ? 'packet' : best.inv.category === 'flavors' ? 'syrup' : 'count')
      : (kind === 'item' || type === 'cup' || type === 'topping') ? 'count'
      : null;
    return { inv: best.inv, score: best.score, amount: style ? guessAmount(style, best.inv) : null };
  }

  return { suggest, tokens };
})();
