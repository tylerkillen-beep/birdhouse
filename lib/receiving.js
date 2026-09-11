// Shared "a delivery arrived" flow for the admin Purchases page and the manager
// Deliveries page.
//
// A receipt line is in purchased units (one 4-pack of syrup) while inventory is
// counted in something else (bottles), so every line carries "counts as": how
// many counted units one purchase adds. Receiving adds arrived x counts-as to
// the count through receive_purchase_order(), one transaction for the whole
// delivery. See supabase/migrations/20260912_receiving.sql.
//
// Loaded as a plain script; everything below is a global, matching the rest
// of the site. It uses each page's own .modal-overlay / .modal / .btn styles.

const RECEIVING_VENDORS = { amazon: 'Amazon', walmart: 'Walmart', other: 'Other' };
const RECEIVING_CATEGORIES = { cold_drinks: 'Cold Drinks', hot_drinks: 'Hot Drinks', flavors: 'Flavors & Syrups', supplies: 'Supplies', baked_goods: 'Baked Goods' };

let receivingState = null;

function receivingEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function receivingToday() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

/** Still expected, and past the date it was supposed to arrive. */
function isDeliveryOverdue(po) {
  return (po.status === 'pending' || po.status === 'partial')
    && !!po.expected_arrival && po.expected_arrival < receivingToday();
}

/** Counted units one purchased unit adds. A confirmed value wins; otherwise
 *  work it out from the pack size when the units line up, else take the pack
 *  count ("12 pack" = 12), else 1. Only ever a starting guess -- whoever is
 *  receiving sees it and can change it. */
function guessCountedPerPurchase(line, inv) {
  const confirmed = Number(line?.counted_per_purchase);
  if (confirmed > 0) return confirmed;
  const packCount = Number(line?.pack_count);
  const packSize = packCount * Number(line?.unit_size);
  const perCounted = Number(inv?.base_units_per_unit);
  const sameUnit = !!inv?.base_unit && !!line?.unit_size_uom
    && inv.base_unit.trim().toLowerCase() === line.unit_size_uom.trim().toLowerCase();
  if (sameUnit && packSize > 0 && perCounted > 0) return Math.round((packSize / perCounted) * 100) / 100;
  if (packCount > 0) return packCount;
  return 1;
}

/** <option>s for an inventory picker, grouped by category, A-Z. */
function receivingInventoryOptions(inventory, selectedId, blankLabel) {
  const groups = {};
  [...inventory].sort((a, b) => a.name.localeCompare(b.name))
    .forEach(i => (groups[i.category || 'other'] ||= []).push(i));
  return `<option value="">${receivingEsc(blankLabel)}</option>` + Object.keys(groups).sort().map(cat =>
    `<optgroup label="${receivingEsc(RECEIVING_CATEGORIES[cat] || cat)}">${groups[cat].map(i =>
      `<option value="${i.id}"${i.id === selectedId ? ' selected' : ''}>${receivingEsc(i.name)}</option>`
    ).join('')}</optgroup>`
  ).join('');
}

/** A box arrived that no uploaded receipt covers. Recording it puts "needs a
 *  receipt" in front of the admin instead of the delivery going untracked. */
function reportUnlistedDelivery(sb, { vendor, note, userId }) {
  return sb.from('purchase_orders').insert({
    vendor,
    status: 'needs_receipt',
    notes: note || null,
    created_by: userId,
    arrived_at: new Date().toISOString(),
  });
}

// -- The Confirm Delivery modal --
// Kept to plain ASCII (entities in markup, \u escapes in text) so it reads the
// same whatever charset the script is served with.
function ensureReceivingStyles() {
  if (document.getElementById('receiving-styles')) return;
  const style = document.createElement('style');
  style.id = 'receiving-styles';
  style.textContent = `
    .receive-help{font-size:0.82rem;color:var(--gray-mid,var(--gray));margin:-0.75rem 0 1rem}
    .receive-line{padding:0.75rem 0;border-bottom:1px solid var(--border-dim,rgba(255,255,255,0.06))}
    .receive-line:last-child{border-bottom:none}
    .receive-name{font-size:0.86rem;font-weight:500}
    .receive-sub{font-size:0.72rem;color:var(--gray-mid,var(--gray));margin-top:0.1rem}
    .receive-fields{display:flex;flex-wrap:wrap;align-items:center;gap:0.4rem 0.6rem;margin-top:0.45rem;font-size:0.76rem;color:var(--gray-mid,var(--gray))}
    .receive-fields select,.receive-fields input{background:#0d0d0d;border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:var(--text,var(--white));font-family:'DM Sans',sans-serif;font-size:0.8rem;padding:0.3rem 0.45rem;outline:none}
    .receive-fields select{max-width:220px}
    .receive-fields input{width:72px}
    .receive-total{font-weight:600;color:#4caf50}
    .receive-total.none{color:var(--gray-mid,var(--gray));font-weight:400}
    .receive-msg{font-size:0.8rem;color:#ff6b6b;margin-top:0.75rem}
    .receive-msg:empty{display:none}
    .receive-actions{display:flex;gap:0.6rem;justify-content:flex-end;margin-top:1.25rem}
  `;
  document.head.appendChild(style);
}

function ensureReceiveModal() {
  let overlay = document.getElementById('receive-modal');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'receive-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'receive-modal-title');
  overlay.innerHTML = `<div class="modal" style="max-width:700px">
    <button class="modal-close" aria-label="Close" onclick="closeReceiveModal()">&#10005;</button>
    <h2 class="modal-title" id="receive-modal-title" style="font-weight:normal">Confirm Delivery</h2>
    <p class="receive-help">Enter what actually came in. Each line adds <em>arrived &times; counts as</em> to the inventory count. Anything short stays open to receive later.</p>
    <div id="receive-lines"></div>
    <div id="receive-msg" class="receive-msg" role="alert"></div>
    <div class="receive-actions">
      <button class="btn btn-ghost" onclick="closeReceiveModal()">Cancel</button>
      <button class="btn btn-primary" id="receive-save" onclick="saveReceiveModal()">Add to Inventory</button>
    </div>
  </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeReceiveModal(); });
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') closeReceiveModal(); });
  document.body.appendChild(overlay);
  return overlay;
}

/** po must include purchase_order_items(*). onDone(newStatus) runs after a
 *  successful save. */
function openReceiveModal({ sb, po, inventory, receivedByName, onDone }) {
  ensureReceivingStyles();
  const overlay = ensureReceiveModal();
  receivingState = { sb, po, inventory: inventory || [], receivedByName, onDone, opener: document.activeElement };

  const vendor = RECEIVING_VENDORS[po.vendor] || po.vendor || '';
  document.getElementById('receive-modal-title').textContent =
    `Confirm Delivery \u2014 ${vendor}${po.order_number ? ' #' + po.order_number : ''}`;
  const items = po.purchase_order_items || [];
  document.getElementById('receive-lines').innerHTML = items.length
    ? items.map(receiveLineHtml).join('')
    : '<p class="receive-sub">This order has no line items.</p>';
  items.forEach(it => updateReceiveLine(it.id));
  document.getElementById('receive-msg').textContent = '';
  document.getElementById('receive-save').disabled = false;
  overlay.classList.add('open');
  overlay.querySelector('.receive-line input')?.focus();
}

function receiveLineHtml(item) {
  const inv = receivingState.inventory.find(i => i.id === item.inventory_id);
  const already = Number(item.received_quantity) || 0;
  const remaining = Math.max(0, (Number(item.quantity) || 0) - already);
  const id = item.id;
  return `<div class="receive-line" data-item-id="${id}">
    <div class="receive-name">${receivingEsc(item.raw_name)}</div>
    <div class="receive-sub">Ordered ${receivingEsc(item.quantity)}${already ? ` &middot; ${receivingEsc(already)} already received` : ''}</div>
    <div class="receive-fields">
      <label for="rcv-inv-${id}">Item</label>
      <select id="rcv-inv-${id}" data-f="inv" onchange="onReceiveItemChange('${id}')">${receivingInventoryOptions(receivingState.inventory, item.inventory_id, '\u2014 Not tracked \u2014')}</select>
      <label for="rcv-qty-${id}">Arrived</label>
      <input type="number" min="0" step="any" id="rcv-qty-${id}" data-f="qty" value="${remaining}" oninput="updateReceiveLine('${id}')"/>
      <label for="rcv-per-${id}">&times; counts as</label>
      <input type="number" min="0" step="any" id="rcv-per-${id}" data-f="per" value="${guessCountedPerPurchase(item, inv)}" oninput="updateReceiveLine('${id}')"/>
      <span data-f="unit">${receivingEsc(inv?.unit || 'units')}</span>
      <span class="receive-total" data-f="total"></span>
    </div>
  </div>`;
}

function onReceiveItemChange(id) {
  const item = receivingState.po.purchase_order_items.find(i => i.id === id);
  const inv = receivingState.inventory.find(i => i.id === document.getElementById(`rcv-inv-${id}`).value);
  // A different item can mean a different pack size, so re-guess -- unless
  // someone already confirmed this line's conversion.
  if (!(Number(item?.counted_per_purchase) > 0)) {
    document.getElementById(`rcv-per-${id}`).value = guessCountedPerPurchase(item, inv);
  }
  updateReceiveLine(id);
}

function updateReceiveLine(id) {
  const row = document.querySelector(`.receive-line[data-item-id="${id}"]`);
  if (!row) return;
  const inv = receivingState.inventory.find(i => i.id === row.querySelector('[data-f="inv"]').value);
  const qty = parseFloat(row.querySelector('[data-f="qty"]').value) || 0;
  const per = parseFloat(row.querySelector('[data-f="per"]').value) || 0;
  row.querySelector('[data-f="unit"]').textContent = inv?.unit || 'units';
  const total = row.querySelector('[data-f="total"]');
  if (!inv) {
    total.textContent = 'not added to inventory';
    total.className = 'receive-total none';
    return;
  }
  const added = Math.round(qty * per * 100) / 100;
  total.textContent = `= +${added} ${inv.unit || 'units'}`;
  total.className = 'receive-total' + (added > 0 ? '' : ' none');
}

async function saveReceiveModal() {
  const st = receivingState;
  if (!st) return;
  const msg = document.getElementById('receive-msg');
  const lines = [];
  for (const row of document.querySelectorAll('#receive-lines .receive-line')) {
    const inventoryId = row.querySelector('[data-f="inv"]').value || null;
    const qty = parseFloat(row.querySelector('[data-f="qty"]').value);
    const per = parseFloat(row.querySelector('[data-f="per"]').value);
    if (!(qty >= 0)) { msg.textContent = 'Every "Arrived" amount needs to be 0 or more.'; return; }
    if (inventoryId && !(per > 0)) { msg.textContent = 'Every "counts as" amount needs to be more than 0.'; return; }
    lines.push({
      item_id: row.dataset.itemId,
      inventory_id: inventoryId,
      received_quantity: qty,
      counted_per_purchase: per > 0 ? per : null,
    });
  }

  const btn = document.getElementById('receive-save');
  btn.disabled = true;
  msg.textContent = '';
  const { data, error } = await st.sb.rpc('receive_purchase_order', {
    p_po_id: st.po.id,
    p_lines: lines,
    p_received_by_name: st.receivedByName || null,
  });
  if (error) {
    btn.disabled = false;
    msg.textContent = /receive_purchase_order/.test(error.message)
      ? 'Receiving isn\u2019t set up yet \u2014 run supabase/migrations/20260912_receiving.sql in the Supabase SQL editor.'
      : 'Error: ' + error.message;
    return;
  }
  closeReceiveModal();
  st.onDone?.(data);
}

function closeReceiveModal() {
  document.getElementById('receive-modal')?.classList.remove('open');
  receivingState?.opener?.focus?.();
}
