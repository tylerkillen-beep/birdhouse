// Item Lookup: every sale of one menu item -- website, register, Square Online
// and subscriptions -- with its months, channels, customers, add-ons and recipe.
// Shared by the Team Hub (student/dashboard.html) and admin (admin/index.html).
//
// Sales come from the item_sales_catalog / item_sales_detail database
// functions, which combine website orders and subscription drinks with the
// register sales that the sync-square-sales edge function copies from Square.
//
//   const lookup = ItemLookup.mount(element, {
//     sb,                     // the page's Supabase client
//     anonKey,                // for calling sync-square-sales
//     theme: { accent, card, border, muted, text },
//     onEditRecipe(recipeId, itemName) { ... },  // recipeId is null for a new recipe
//   });
//   lookup.refreshRecipe();   // after a recipe is saved
//   lookup.refreshStatus();   // when the view is shown again
//
// The file stays plain ASCII -- punctuation like the dash is built from its
// character code -- so it reads the same whatever charset it is served with.

(function () {
  const SYNC_FN_URL = 'https://ljukrhneikqbabcmcpet.supabase.co/functions/v1/sync-square-sales';
  const CHANNELS = { website: 'Website', register: 'Register', square_online: 'Square Online', subscription: 'Subscription' };
  const DASH = String.fromCharCode(0x2014);
  const DOT = String.fromCharCode(0x00b7);
  const ELLIPSIS = String.fromCharCode(0x2026);

  const STYLES = `
    .il { color:var(--il-text); }
    .il-sync { display:flex; align-items:center; justify-content:space-between; gap:0.75rem; flex-wrap:wrap; font-size:0.78rem; color:var(--il-muted); background:var(--il-card); border:1px solid var(--il-border); border-radius:10px; padding:0.6rem 0.9rem; margin-bottom:1rem; }
    .il-sync.warn { color:#ff9800; border-color:rgba(255,152,0,0.3); }
    .il-btn { background:rgba(255,255,255,0.04); border:1px solid var(--il-border); border-radius:7px; padding:0.4rem 0.9rem; font-size:0.78rem; color:var(--il-muted); cursor:pointer; font-family:'DM Sans',sans-serif; transition:all 0.2s; white-space:nowrap; }
    .il-btn:hover { color:var(--il-text); border-color:var(--il-accent); }
    .il-btn:disabled { opacity:0.5; cursor:wait; }
    .il-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
    .il-search { width:100%; padding:0.85rem 1rem; border:1px solid var(--il-border); border-radius:8px; background:rgba(0,0,0,0.35); font-family:'DM Sans',sans-serif; font-size:0.9rem; color:var(--il-text); outline:none; }
    .il-search:focus { border-color:var(--il-accent); }
    .il-results { display:flex; flex-direction:column; gap:0.35rem; margin:0.6rem 0 1.5rem; }
    .il-results-label { font-size:0.7rem; color:var(--il-muted); text-transform:uppercase; letter-spacing:0.1em; }
    .il-result { display:flex; align-items:center; gap:0.75rem; width:100%; text-align:left; background:var(--il-card); border:1px solid var(--il-border); border-radius:9px; padding:0.65rem 0.9rem; color:var(--il-text); font-family:'DM Sans',sans-serif; font-size:0.86rem; cursor:pointer; transition:border-color 0.2s; }
    .il-result:hover, .il-result.active { border-color:var(--il-accent); }
    .il-result-name { flex:1; }
    .il-result-meta { font-size:0.74rem; color:var(--il-muted); white-space:nowrap; }
    .il-badge { font-size:0.62rem; padding:0.12rem 0.45rem; border-radius:10px; border:1px solid var(--il-border); color:var(--il-muted); margin-left:0.4rem; vertical-align:middle; }
    .il-head { display:flex; align-items:baseline; gap:0.6rem; flex-wrap:wrap; margin-bottom:0.25rem; }
    .il-title { font-family:'Bebas Neue',sans-serif; font-size:2rem; letter-spacing:0.04em; }
    .il-sub { font-size:0.78rem; color:var(--il-muted); margin-bottom:1.25rem; line-height:1.5; }
    .il-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:0.85rem; margin-bottom:2rem; }
    .il-stat { background:var(--il-card); border:1px solid var(--il-border); border-radius:12px; padding:1.1rem 1.25rem; }
    .il-stat-label { font-size:0.65rem; text-transform:uppercase; letter-spacing:0.12em; color:var(--il-muted); margin-bottom:0.4rem; }
    .il-stat-value { font-family:'Bebas Neue',sans-serif; font-size:2rem; letter-spacing:0.03em; color:var(--il-accent); line-height:1.1; }
    .il-stat-value.small { font-size:1.3rem; }
    .il-stat-note { font-size:0.7rem; color:var(--il-muted); margin-top:0.3rem; line-height:1.4; }
    .il-section { margin-bottom:2rem; }
    .il-section-title { font-family:'Bebas Neue',sans-serif; font-size:1.35rem; letter-spacing:0.05em; margin-bottom:0.85rem; font-weight:normal; }
    .il-chart { display:flex; align-items:flex-end; gap:0.4rem; height:170px; padding:1rem 1rem 0; background:var(--il-card); border:1px solid var(--il-border); border-radius:12px; overflow-x:auto; }
    .il-bar-wrap { flex:1; min-width:34px; display:flex; flex-direction:column; align-items:center; gap:0.4rem; height:100%; justify-content:flex-end; }
    .il-bar { width:100%; background:var(--il-accent); border-radius:3px 3px 0 0; opacity:0.75; min-height:3px; }
    .il-bar:hover { opacity:1; }
    .il-bar-label { font-size:0.62rem; color:var(--il-muted); text-align:center; padding-bottom:0.5rem; line-height:1.3; }
    .il-table-wrap { background:var(--il-card); border:1px solid var(--il-border); border-radius:12px; overflow-x:auto; margin-top:1rem; }
    .il-table { width:100%; min-width:520px; border-collapse:collapse; }
    .il-table th { text-align:left; font-size:0.62rem; text-transform:uppercase; letter-spacing:0.12em; color:var(--il-muted); padding:0.65rem 1rem; border-bottom:1px solid var(--il-border); font-weight:500; white-space:nowrap; }
    .il-table td { padding:0.6rem 1rem; border-bottom:1px solid rgba(255,255,255,0.03); font-size:0.84rem; }
    .il-table tr:last-child td { border-bottom:none; }
    .il-table .il-num { color:var(--il-muted); }
    .il-table tr.il-anon td { color:var(--il-muted); font-style:italic; }
    .il-chips { display:flex; flex-wrap:wrap; gap:0.4rem; }
    .il-chip { font-size:0.78rem; background:rgba(255,255,255,0.04); border:1px solid var(--il-border); border-radius:6px; padding:0.2rem 0.6rem; color:var(--il-muted); }
    .il-chip strong { color:var(--il-text); font-weight:500; margin-left:0.3rem; }
    .il-note { font-size:0.72rem; color:var(--il-muted); margin-top:0.5rem; }
    .il-empty { color:var(--il-muted); text-align:center; padding:1.5rem; font-size:0.85rem; }
    .il-error { color:#e57373; }
    .il-recipe { background:var(--il-card); border:1px solid var(--il-border); border-radius:12px; padding:1.1rem 1.25rem; }
    .il-recipe-top { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
    .il-recipe-name { font-weight:600; font-size:0.95rem; }
    .il-recipe-line { font-size:0.74rem; color:var(--il-muted); margin-top:0.2rem; }
    .il-recipe .il-chips { margin-top:0.6rem; }
    @media (max-width:900px) { .il-stats { grid-template-columns:1fr 1fr; } }
  `;

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const norm = s => String(s || '').trim().toLowerCase();
  const money = cents => `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const units = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const day = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : DASH;
  const month = ym => new Date(ym + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  function injectStyles() {
    if (document.getElementById('item-lookup-styles')) return;
    const style = document.createElement('style');
    style.id = 'item-lookup-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  let mountCount = 0;

  function mount(root, options) {
    const { sb, anonKey, onEditRecipe } = options;
    const theme = { accent: '#cc0000', card: '#141414', border: 'rgba(255,255,255,0.08)', muted: '#888', text: '#f0f0f0', ...(options.theme || {}) };
    injectStyles();

    const searchId = `il-search-${++mountCount}`;
    root.classList.add('il');
    Object.entries(theme).forEach(([k, v]) => root.style.setProperty(`--il-${k}`, v));
    root.innerHTML = `
      <div class="il-sync" data-el="sync">
        <span data-el="sync-text">Checking register sales${ELLIPSIS}</span>
        <button type="button" class="il-btn" data-el="sync-btn">Sync now</button>
      </div>
      <label class="il-sr-only" for="${searchId}">Search menu items</label>
      <input type="text" class="il-search" id="${searchId}" placeholder="Search for an item${ELLIPSIS}" autocomplete="off" />
      <div class="il-results" data-el="results" role="list" aria-label="Matching items"></div>
      <div data-el="detail"></div>`;
    const el = name => root.querySelector(`[data-el="${name}"]`);
    const search = root.querySelector('.il-search');

    let catalog = null;
    let selectedKey = null;
    let detailRequest = 0;

    const currentItem = () => (catalog || []).find(i => i.item_key === selectedKey);

    search.addEventListener('input', renderResults);
    el('sync-btn').addEventListener('click', syncNow);
    el('results').addEventListener('click', e => {
      const btn = e.target.closest('[data-key]');
      if (btn) selectItem(btn.dataset.key);
    });
    el('detail').addEventListener('click', e => {
      const btn = e.target.closest('[data-recipe-edit]');
      if (!btn || !onEditRecipe) return;
      onEditRecipe(btn.dataset.recipeEdit || null, currentItem()?.name || '');
    });

    async function loadCatalog() {
      el('results').innerHTML = `<div class="il-empty">Loading items${ELLIPSIS}</div>`;
      // The API returns at most 1,000 rows per request, and years of register
      // history can name more items than that, so read it in pages.
      const PAGE = 1000;
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb.rpc('item_sales_catalog').range(from, from + PAGE - 1);
        if (error) {
          el('results').innerHTML = `<div class="il-empty il-error">Couldn't load items: ${esc(error.message)}</div>`;
          return;
        }
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
      }
      catalog = rows;
      renderResults();
    }

    async function refreshStatus() {
      const box = el('sync');
      const text = el('sync-text');
      const { data: s } = await sb.from('square_sales_sync').select('*').maybeSingle();
      box.classList.remove('warn');
      if (!s) {
        text.textContent = `Register sales haven't been copied from Square yet ${DASH} only website and subscription sales are shown.`;
        box.classList.add('warn');
        return;
      }
      const through = s.synced_through
        ? new Date(s.synced_through).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : DASH;
      const history = s.backfill_done ? 'Full history imported.' : `Importing history ${DASH} back to ${day(s.backfill_before)} so far.`;
      text.textContent = `Register sales copied through ${through}. ${history}`;
      if (s.last_error) {
        text.textContent += ` Last sync failed: ${s.last_error}`;
        box.classList.add('warn');
      }
    }

    async function syncNow() {
      const btn = el('sync-btn');
      btn.disabled = true;
      btn.textContent = `Syncing${ELLIPSIS}`;
      try {
        let { data: { session } } = await sb.auth.getSession();
        if (session?.expires_at && Date.now() / 1000 >= session.expires_at - 30) {
          const { data: refreshed } = await sb.auth.refreshSession();
          session = refreshed?.session ?? null;
        }
        if (!session) throw new Error('Session expired. Please sign in again.');
        let res;
        try {
          res = await fetch(SYNC_FN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${session.access_token}` },
            body: '{}',
            // A run replies within about a minute; past that, stop waiting.
            signal: AbortSignal.timeout(90000),
          });
        } catch (err) {
          throw new Error(err?.name === 'TimeoutError'
            ? 'no reply after 90 seconds. Check the function logs in Supabase.'
            : 'the sync function could not be reached. Check that it is deployed with JWT verification off.');
        }
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.success) throw new Error(d.error || `the function replied with status ${res.status}`);
        await Promise.all([refreshStatus(), loadCatalog()]);
        if (selectedKey) selectItem(selectedKey);
      } catch (err) {
        // Show whatever progress earlier runs made, then why this one failed.
        await refreshStatus().catch(() => {});
        el('sync-text').textContent += ` Sync failed: ${err.message}`;
        el('sync').classList.add('warn');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync now';
      }
    }

    function renderResults() {
      if (!catalog) return;
      const q = norm(search.value);
      // An item matches on its menu name or on any name it was rung up as, so
      // an item renamed in Square is still found by its old name.
      const oldNameMatch = i => q && !norm(i.name).includes(q)
        ? (i.sold_as || []).find(n => norm(n).includes(q)) : null;
      const matches = catalog.filter(i => !q || norm(i.name).includes(q) || oldNameMatch(i));
      // Exact and starts-with matches first, then busiest.
      if (q) matches.sort((a, b) => {
        const rank = i => {
          const names = [i.name, ...(i.sold_as || [])].map(norm);
          return names.includes(q) ? 0 : names.some(n => n.startsWith(q)) ? 1 : 2;
        };
        return rank(a) - rank(b) || Number(b.units) - Number(a.units);
      });
      const shown = matches.slice(0, q ? 12 : 8);
      if (!shown.length) { el('results').innerHTML = '<div class="il-empty">No items match that search.</div>'; return; }
      el('results').innerHTML = (q ? '' : '<div class="il-results-label">Best sellers</div>') +
        shown.map(i => `<button type="button" class="il-result${i.item_key === selectedKey ? ' active' : ''}" role="listitem" data-key="${esc(i.item_key)}">
          <span class="il-result-name">${esc(i.name)}${i.retired ? '<span class="il-badge">Retired</span>' : ''}${!i.menu_item_id ? '<span class="il-badge">Not on menu</span>' : ''}${oldNameMatch(i) ? `<span class="il-badge">sold as ${esc(oldNameMatch(i))}</span>` : ''}</span>
          <span class="il-result-meta">${Number(i.units) ? `${units(i.units)} sold ${DOT} last ${day(i.last_sold)}` : 'No sales yet'}</span>
        </button>`).join('');
    }

    async function selectItem(key, retried = false) {
      selectedKey = key;
      renderResults();
      const detail = el('detail');
      detail.innerHTML = `<div class="il-empty">Loading sales${ELLIPSIS}</div>`;
      const requestId = ++detailRequest;
      const { data, error } = await sb.rpc('item_sales_detail', { p_item_key: key });
      if (requestId !== detailRequest) return; // another item was picked meanwhile
      if (error) { detail.innerHTML = `<div class="il-empty il-error">Couldn't load sales: ${esc(error.message)}</div>`; return; }

      // The list said this item sold, but nothing sold under its key. The sync
      // has since matched those sales to a menu item, which files them under a
      // new key -- so reload the list and open the same item by name.
      const item = currentItem();
      if (!retried && item && Number(item.units) && !Number(data?.totals?.units)) {
        detail.innerHTML = `<div class="il-empty">Sales were re-matched since this list loaded. Refreshing${ELLIPSIS}</div>`;
        await loadCatalog();
        if (requestId !== detailRequest) return;
        const renamed = (catalog || [])
          .filter(i => Number(i.units) && [i.name, ...(i.sold_as || [])].some(n => norm(n) === norm(item.name)))
          .sort((a, b) => Number(b.units) - Number(a.units))[0];
        if (renamed) return selectItem(renamed.item_key, true);
        detail.innerHTML = `<div class="il-empty">Sales of ${esc(item.name)} now belong to the menu item they were rung up as. Search for that item above.</div>`;
        return;
      }

      renderDetail(item, data || {});
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderDetail(item, d) {
      const t = d.totals || {};
      const name = item?.name || (t.names_sold_as || [])[0] || 'Item';
      const recipeSection = `<div class="il-section"><h2 class="il-section-title">Recipe</h2><div data-el="recipe"><div class="il-empty">Loading recipe${ELLIPSIS}</div></div></div>`;

      if (!Number(t.units)) {
        el('detail').innerHTML = `
          <div class="il-head"><div class="il-title">${esc(name)}</div></div>
          <div class="il-sub">No sales recorded for this item yet.</div>
          ${recipeSection}`;
        refreshRecipe();
        return;
      }

      const avgCents = Number(t.priced_units) ? Number(t.revenue_cents) / Number(t.priced_units) : 0;
      const otherNames = (t.names_sold_as || []).filter(n => norm(n) !== norm(name));
      const subscriptionUnits = (d.by_channel || []).find(c => c.channel === 'subscription')?.units || 0;
      const anonUnits = (d.customers || []).filter(c => c.anonymous).reduce((s, c) => s + Number(c.units), 0);

      const stat = (label, value, note, small) =>
        `<div class="il-stat"><div class="il-stat-label">${label}</div><div class="il-stat-value${small ? ' small' : ''}">${value}</div>${note ? `<div class="il-stat-note">${note}</div>` : ''}</div>`;
      const stats = `<div class="il-stats">
        ${stat('Units Sold', units(t.units), `${units(t.orders)} order${Number(t.orders) === 1 ? '' : 's'}`)}
        ${stat('Revenue', money(t.revenue_cents), [
          Number(t.discount_cents) ? `after ${money(t.discount_cents)} in discounts` : '',
          Number(subscriptionUnits) ? `+ ${units(subscriptionUnits)} subscription drinks (billed by plan)` : '',
        ].filter(Boolean).join('<br>'))}
        ${stat('Avg Price Paid', avgCents ? money(avgCents) : DASH, 'per unit')}
        ${stat('Named Customers', units(t.customers), anonUnits ? `+ ${units(anonUnits)} sold with no name attached` : '')}
        ${stat('First Sold', day(t.first_sold), '', true)}
        ${stat('Last Sold', day(t.last_sold), '', true)}
      </div>`;

      const months = d.by_month || [];
      const maxUnits = Math.max(...months.map(m => Number(m.units)), 1);
      const chart = `<div class="il-chart" role="img" aria-label="Units sold per month for ${esc(name)}">
        ${months.map(m => `<div class="il-bar-wrap"><div class="il-bar" style="height:${Math.max(Math.round(Number(m.units) / maxUnits * 100), 2)}%" title="${month(m.month)}: ${units(m.units)} sold"></div><div class="il-bar-label">${month(m.month).replace(' ', '<br>')}<br>${units(m.units)}</div></div>`).join('')}
      </div>`;
      const channelCols = Object.keys(CHANNELS).filter(c => months.some(m => Number(m[c + '_units'])));
      const monthTable = `<div class="il-table-wrap"><table class="il-table">
        <thead><tr><th scope="col">Month</th><th scope="col">Units</th>${channelCols.map(c => `<th scope="col">${CHANNELS[c]}</th>`).join('')}<th scope="col">Revenue</th></tr></thead>
        <tbody>${months.slice().reverse().map(m => `<tr><td>${month(m.month)}</td><td>${units(m.units)}</td>${channelCols.map(c => `<td class="il-num">${units(m[c + '_units'])}</td>`).join('')}<td>${money(m.revenue_cents)}</td></tr>`).join('')}</tbody>
      </table></div>`;

      const channels = `<div class="il-chips">${(d.by_channel || []).map(c =>
        `<span class="il-chip">${CHANNELS[c.channel] || esc(c.channel)}<strong>${units(c.units)} sold${c.channel === 'subscription' ? '' : ` ${DOT} ${money(c.revenue_cents)}`}</strong></span>`).join('')}</div>`;

      let rank = 0;
      const customers = `<div class="il-table-wrap" style="margin-top:0"><table class="il-table">
        <thead><tr><th scope="col">#</th><th scope="col">Customer</th><th scope="col">Bought</th><th scope="col">Spent</th><th scope="col">Last Bought</th></tr></thead>
        <tbody>${(d.customers || []).map(c => `<tr class="${c.anonymous ? 'il-anon' : ''}"><td class="il-num">${c.anonymous ? '' : ++rank}</td><td>${esc(c.name)}</td><td>${units(c.units)}</td><td>${money(c.revenue_cents)}</td><td>${day(c.last_bought)}</td></tr>`).join('')}</tbody>
      </table></div>`;

      const modifiers = (d.modifiers || []).length
        ? `<div class="il-chips">${d.modifiers.map(m => `<span class="il-chip">${esc(m.name)}<strong>${units(m.units)}</strong></span>`).join('')}</div>`
        : '<div class="il-note" style="margin-top:0">No add-ons recorded for this item.</div>';

      el('detail').innerHTML = `
        <div class="il-head"><div class="il-title">${esc(name)}</div>${item?.category ? `<span class="il-badge">${esc(item.category)}</span>` : ''}</div>
        <div class="il-sub">${otherNames.length ? `Also sold as: ${otherNames.map(esc).join(', ')}. ` : ''}Months use Central time. Subscription drinks count once delivered.</div>
        ${stats}
        <div class="il-section"><h2 class="il-section-title">By Month</h2>${chart}${monthTable}</div>
        <div class="il-section"><h2 class="il-section-title">By Channel</h2>${channels}</div>
        <div class="il-section"><h2 class="il-section-title">Top Customers</h2>${customers}
          <div class="il-note">Register sales only have a name when a customer was attached at checkout.</div></div>
        <div class="il-section"><h2 class="il-section-title">Popular Add-ons</h2>${modifiers}</div>
        ${recipeSection}`;
      refreshRecipe();
    }

    async function refreshRecipe() {
      const target = el('recipe');
      const item = currentItem();
      if (!target || !item) return;
      let recipeId = null;
      if (item.menu_item_id) {
        const { data: link } = await sb.from('menu_item_recipe_links').select('recipe_id').eq('menu_item_id', item.menu_item_id).maybeSingle();
        recipeId = link?.recipe_id || null;
      }
      const query = sb.from('recipes').select('*, recipe_ingredients(*, inventory:inventory_id(id,name,unit))');
      const { data: recipes } = recipeId
        ? await query.eq('id', recipeId)
        : await query.ilike('name', item.name.replace(/[\\%_]/g, '\\$&'));
      if (!root.contains(target)) return; // a different item is showing now
      const recipe = (recipes || [])[0];
      const editBtn = label => onEditRecipe ? `<button type="button" class="il-btn" data-recipe-edit="${recipe ? esc(recipe.id) : ''}">${label}</button>` : '';

      if (!recipe) {
        target.innerHTML = `<div class="il-recipe il-recipe-top" style="align-items:center">
          <span style="color:var(--il-muted);font-size:0.85rem">No recipe yet for this item.</span>${editBtn('+ Add Recipe')}</div>`;
        return;
      }
      const machine = recipe.coffee_machine_selection
        ? recipe.coffee_machine_selection + (recipe.coffee_machine_flavor ? ` (${recipe.coffee_machine_flavor})` : '')
        : '';
      const build = [recipe.cup_type ? `${recipe.cup_type} cup` : '', recipe.ice_amount ? `${recipe.ice_amount} ice` : '', machine, recipe.beverage_pour].filter(Boolean);
      const extras = [
        recipe.packet ? `Packet: ${recipe.packet}` : '',
        recipe.syrups ? `Syrups: ${recipe.syrups}` : '',
        recipe.boba ? `Boba: ${recipe.boba}` : '',
        recipe.toppings ? `Toppings: ${recipe.toppings}` : '',
      ].filter(Boolean);
      const ingredients = (recipe.recipe_ingredients || []).map(ri =>
        `<span class="il-chip">${esc(ri.amount)} ${esc(ri.unit || ri.inventory?.unit || '')} ${esc(ri.inventory?.name || '?')}</span>`).join('');
      target.innerHTML = `<div class="il-recipe">
        <div class="il-recipe-top">
          <div>
            <div class="il-recipe-name">${esc(recipe.name)}</div>
            ${recipe.description ? `<div class="il-recipe-line">${esc(recipe.description)}</div>` : ''}
            ${build.length ? `<div class="il-recipe-line">${esc(build.join(` ${DOT} `))}</div>` : ''}
            ${extras.length ? `<div class="il-recipe-line" style="color:var(--il-text)">${esc(extras.join(` ${DOT} `))}</div>` : ''}
          </div>
          ${editBtn('Edit Recipe')}
        </div>
        ${ingredients ? `<div class="il-chips">${ingredients}</div>` : ''}
      </div>`;
    }

    refreshStatus();
    loadCatalog();
    return { refreshRecipe, refreshStatus };
  }

  window.ItemLookup = { mount };
})();
