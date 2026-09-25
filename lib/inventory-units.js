// Counting by eye while stock is kept in the ordering unit.
//
// An item converted to its ordering unit (see supabase/migrations/
// 20260926_inventory_base_units.sql) keeps `quantity` and `par_level` in that unit
// (oz, each) and remembers what people count it by (`count_unit`, e.g. "Bottles")
// and how many of the ordering unit are in one (`count_unit_size`, e.g. 32). This
// lets a screen show "96 oz (3 Bottles)" and lets a student type "3" against
// "Bottles" while 96 is what gets saved.
//
// Items that haven't been converted have no count unit, and everything here falls
// back to the plain number and unit label they always had.
//
//   InvUnits.format(item, 96)                 -> "96 oz (3 Bottles)"
//   InvUnits.entry('qty-<id>', item, 96, {...}) -> <input> plus a unit picker (or the
//                                                 caller's plain unit label)
//   InvUnits.read('qty-<id>')                 -> the quantity to save, in the item's unit
//
// Loaded as a plain script; everything is under the InvUnits global.

const InvUnits = (function () {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const trim = (n, d = 2) => String(Number(Number(n).toFixed(d)));

  /** { size, label } when the item is counted by eye in something else, else null. */
  function helper(item) {
    const size = Number(item?.count_unit_size);
    const label = String(item?.count_unit ?? '').trim();
    return size > 0 && label ? { size, label } : null;
  }

  /** "96 oz (3 Bottles)", or just "96 oz" when there is no count unit. */
  function format(item, qty) {
    const q = Number(qty) || 0;
    const unit = String(item?.unit ?? '').trim();
    const h = helper(item);
    const base = `${trim(q)}${unit ? ' ' + unit : ''}`;
    return h ? `${base} (${trim(q / h.size)} ${h.label})` : base;
  }

  /**
   * An input for a quantity, in the count unit when the item has one, with a picker
   * to switch to the ordering unit. o: { cls, style, label, unitHtml, selectStyle }.
   * unitHtml is what the screen already shows beside the input, used as is when the
   * item has no count unit.
   */
  function entry(id, item, qty, o = {}) {
    const cls = o.cls ? ` class="${esc(o.cls)}"` : '';
    const style = o.style ? ` style="${esc(o.style)}"` : '';
    const aria = o.label ? ` aria-label="${esc(o.label)}"` : '';
    const h = helper(item);
    const q = Number(qty) || 0;
    if (!h) {
      return `<input${cls}${style}${aria} type="number" id="${esc(id)}" value="${q}" min="0" step="0.5"/>${o.unitHtml ?? ''}`;
    }
    const selStyle = o.selectStyle ? ` style="${esc(o.selectStyle)}"` : ' style="max-width:9rem;background:transparent;color:inherit;border:1px solid rgba(255,255,255,0.15);border-radius:6px;font-size:0.78rem;padding:0.25rem 0.3rem"';
    return `<input${cls}${style}${aria} type="number" id="${esc(id)}" value="${trim(q / h.size)}" min="0" step="any"/>`
      + `<select id="${esc(id)}-u" data-prev="${h.size}"${selStyle} aria-label="Unit" onchange="InvUnits.switchUnit('${esc(id)}')">`
      + `<option value="${h.size}">${esc(h.label)}</option><option value="1">${esc(item.unit || 'units')}</option></select>`;
  }

  /** The picker changed: show the same amount in the other unit. */
  function switchUnit(id) {
    const input = document.getElementById(id);
    const sel = document.getElementById(id + '-u');
    if (!input || !sel) return;
    const prev = parseFloat(sel.dataset.prev) || 1;
    const cur = parseFloat(sel.value) || 1;
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) input.value = trim(v * prev / cur, 4);
    sel.dataset.prev = String(cur);
  }

  /** What was entered, in the item's own unit (NaN if the box isn't a number). */
  function read(id) {
    const input = document.getElementById(id);
    if (!input) return NaN;
    const sel = document.getElementById(id + '-u');
    const v = parseFloat(input.value) * (sel ? parseFloat(sel.value) || 1 : 1);
    return Math.round(v * 10000) / 10000;
  }

  return { helper, format, entry, switchUnit, read };
})();
