// Watchlist Pro for Upstox — Content Script
// Injects a sidebar panel into tv.upstox.com with full watchlist management
(function () {
  'use strict';

  // ─── Instrument Data ───
  let instruments = {}; // { "NSE:HDFCBANK": { i:"INE040A01034", n:"HDFC BANK LTD", s:"HDFC Bank" }, ... }

  function loadInstruments() {
    return fetch(chrome.runtime.getURL('instruments-upstox.json'))
      .then(r => r.json())
      .then(data => { instruments = data; })
      .catch(() => { instruments = {}; });
  }

  function getIsin(key) {
    const e = instruments[key];
    if (!e) return null;
    return e.i || null;
  }

  function getDisplayName(key) {
    const e = instruments[key];
    if (!e || typeof e === 'string') return '';
    return e.s || e.n || '';
  }

  // ─── URL Builder ───
  // Using TradingView API to switch charts without reloading!
  function changeUpstoxChart(isin, symbolName) {
    // To bypass Content Security Policy (CSP) blocking inline scripts,
    // we send a message to background.js to execute the script in the MAIN world.
    chrome.runtime.sendMessage({
      action: 'change-upstox-chart',
      isin: isin,
      symbolName: symbolName
    });
  }

  function navigateToSymbol(sym) {
    const isin = getIsin(sym);
    if (!isin) {
      showToast(`Symbol "${sym}" not found in instruments`);
      return;
    }

    // sym is format "NSE:HDFCBANK"
    const parts = sym.split(':');
    const symbolName = parts[1] || sym;

    // Switch chart directly via TradingView API
    changeUpstoxChart(isin, symbolName);
  }

  // ─── Search ───
  function searchInstruments(query, limit = 40) {
    if (!query || query.length < 1) return [];
    const q = query.toUpperCase();
    const results = [];
    for (const [key, entry] of Object.entries(instruments)) {
      const symbol = key.split(':')[1] || key;
      const name = (typeof entry === 'object' ? (entry.n || '') : '').toUpperCase();
      const shortName = (typeof entry === 'object' ? (entry.s || '') : '').toUpperCase();
      if (symbol.startsWith(q) || key.includes(q) || name.includes(q) || shortName.includes(q)) {
        results.push(key);
        if (results.length >= limit) break;
      }
    }
    results.sort((a, b) => {
      const sa = a.split(':')[1] || a;
      const sb = b.split(':')[1] || b;
      const aS = sa.startsWith(q), bS = sb.startsWith(q);
      if (aS && !bS) return -1;
      if (!aS && bS) return 1;
      return sa.localeCompare(sb);
    });
    return results;
  }

  // ─── Storage ───
  const STORE_KEY = 'wlpro_data';
  function loadData(cb) {
    chrome.storage.sync.get(null, syncRes => {
      // 1. Try to load chunked data
      const chunkKeys = Object.keys(syncRes).filter(k => k.startsWith(STORE_KEY + '_'));
      if (chunkKeys.length > 0) {
        chunkKeys.sort((a, b) => parseInt(a.split('_').pop()) - parseInt(b.split('_').pop()));
        try {
          const jsonStr = chunkKeys.map(k => syncRes[k]).join('');
          cb(JSON.parse(jsonStr));
          return;
        } catch (e) {
          console.error("Failed to parse chunked sync data", e);
        }
      } else if (syncRes[STORE_KEY]) {
        // 2. Legacy unchunked fallback
        cb(syncRes[STORE_KEY]);
        return;
      }
      
      // 3. Fallback to local
      chrome.storage.local.get(STORE_KEY, localRes => {
        cb(localRes[STORE_KEY] || { lists: [{ name: 'Default', symbols: [] }], activeIndex: 0 });
      });
    });
  }

  const CHUNK_SIZE = 7500; // Safe limit below 8192 bytes
  function saveData(data, cb) {
    chrome.storage.local.set({ [STORE_KEY]: data }, () => {
      if (chrome.runtime.lastError) console.error("Local storage error:", chrome.runtime.lastError);
      
      // Stringify and chunk data to bypass 8KB limit per item
      const jsonStr = JSON.stringify(data);
      const chunks = {};
      for (let i = 0; i < jsonStr.length; i += CHUNK_SIZE) {
        chunks[`${STORE_KEY}_${i / CHUNK_SIZE}`] = jsonStr.substring(i, i + CHUNK_SIZE);
      }
      
      chrome.storage.sync.get(null, syncRes => {
        // Clear old chunks before saving new ones
        const oldKeys = Object.keys(syncRes).filter(k => k.startsWith(STORE_KEY));
        chrome.storage.sync.remove(oldKeys, () => {
          chrome.storage.sync.set(chunks, () => {
            if (chrome.runtime.lastError) {
              console.warn("Sync storage failed:", chrome.runtime.lastError.message);
            }
            if (cb) cb();
          });
        });
      });
    });
  }

  // ─── Toast ───
  function showToast(msg) {
    let t = document.getElementById('wlpro-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'wlpro-toast';
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('wlpro-toast-show');
    setTimeout(() => t.classList.remove('wlpro-toast-show'), 2500);
  }

  // ─── Panel ───
  let panel = null;
  let visible = false;
  let data = null;
  let activeIdx = -1;
  let filtered = [];

  function createPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'wlpro-panel';
    panel.classList.add('wlpro-hidden');
    panel.innerHTML = `
      <div class="wlpro-header">
        <span class="wlpro-title">📋 Watchlist Pro</span>
        <div class="wlpro-header-btns">
          <button id="wlpro-add" title="Add symbol">＋</button>
          <button id="wlpro-import" title="Import symbols">⬆</button>
          <button id="wlpro-close" title="Close">✕</button>
        </div>
      </div>
      <div class="wlpro-toolbar">
        <select id="wlpro-select"></select>
        <button id="wlpro-new" title="New watchlist">📁</button>
        <button id="wlpro-del" title="Delete watchlist">🗑</button>
      </div>
      <div class="wlpro-newrow" id="wlpro-newrow">
        <input id="wlpro-newname" type="text" placeholder="Watchlist name…">
        <button id="wlpro-newsave">Save</button>
        <button id="wlpro-newcancel">✕</button>
      </div>
      <div class="wlpro-search-wrap">
        <input id="wlpro-filter" type="text" placeholder="🔍  Filter symbols…">
      </div>
      <div class="wlpro-list" id="wlpro-list"></div>
      <div class="wlpro-footer">
        <span id="wlpro-count">0 symbols</span>
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate <kbd>Enter</kbd> Open</span>
      </div>`;
    document.documentElement.appendChild(panel);
    bindEvents();
    refresh();
  }

  function show() { 
    if (!panel) createPanel(); 
    panel.classList.remove('wlpro-hidden'); 
    document.body.classList.add('wlpro-open');
    visible = true; 
    refresh(); 
  }
  function hide() { 
    if (panel) panel.classList.add('wlpro-hidden'); 
    document.body.classList.remove('wlpro-open');
    visible = false; 
  }
  function toggle() { visible ? hide() : show(); return visible; }

  // ─── Events ───
  function bindEvents() {
    panel.querySelector('#wlpro-close').onclick = hide;

    // Watchlist selector
    panel.querySelector('#wlpro-select').onchange = function () {
      data.activeIndex = parseInt(this.value) || 0;
      saveData(data, () => renderList());
    };

    // New watchlist
    panel.querySelector('#wlpro-new').onclick = () => {
      const row = panel.querySelector('#wlpro-newrow');
      row.classList.toggle('visible');
      if (row.classList.contains('visible')) panel.querySelector('#wlpro-newname').focus();
    };
    panel.querySelector('#wlpro-newcancel').onclick = () => panel.querySelector('#wlpro-newrow').classList.remove('visible');
    panel.querySelector('#wlpro-newsave').onclick = () => {
      const name = panel.querySelector('#wlpro-newname').value.trim();
      if (!name) return;
      data.lists.push({ name, symbols: [] });
      data.activeIndex = data.lists.length - 1;
      saveData(data, () => { panel.querySelector('#wlpro-newname').value = ''; panel.querySelector('#wlpro-newrow').classList.remove('visible'); refresh(); });
    };
    panel.querySelector('#wlpro-newname').onkeydown = e => {
      if (e.key === 'Enter') panel.querySelector('#wlpro-newsave').click();
      if (e.key === 'Escape') panel.querySelector('#wlpro-newcancel').click();
    };

    // Delete watchlist
    panel.querySelector('#wlpro-del').onclick = () => {
      if (data.lists.length <= 1) return showToast('Cannot delete the last watchlist');
      if (confirm(`Delete "${data.lists[data.activeIndex].name}"?`)) {
        data.lists.splice(data.activeIndex, 1);
        data.activeIndex = Math.min(data.activeIndex, data.lists.length - 1);
        saveData(data, refresh);
      }
    };

    // Add symbol
    panel.querySelector('#wlpro-add').onclick = showAddModal;

    // Import
    panel.querySelector('#wlpro-import').onclick = showImportModal;

    // Filter
    panel.querySelector('#wlpro-filter').oninput = () => renderList();

    // Keyboard nav
    panel.onkeydown = e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      const items = panel.querySelectorAll('.wlpro-item');
      if (!items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); highlight(items); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(items); }
      else if (e.key === 'Enter' && activeIdx >= 0 && activeIdx < filtered.length) { navigateToSymbol(filtered[activeIdx]); }
    };
    panel.tabIndex = -1;
  }

  function highlight(items) {
    items.forEach((el, i) => {
      el.classList.toggle('wlpro-active', i === activeIdx);
      if (i === activeIdx) el.scrollIntoView({ block: 'nearest' });
    });
  }

  // ─── Rendering ───
  function refresh() {
    loadData(d => { data = d; renderSelect(); renderList(); });
  }

  function renderSelect() {
    const sel = panel.querySelector('#wlpro-select');
    sel.innerHTML = '';
    data.lists.forEach((l, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = l.name;
      if (i === data.activeIndex) o.selected = true;
      sel.appendChild(o);
    });
  }

  function renderList() {
    const listEl = panel.querySelector('#wlpro-list');
    const countEl = panel.querySelector('#wlpro-count');
    const list = data.lists[data.activeIndex];
    if (!list) { listEl.innerHTML = ''; countEl.textContent = '0'; return; }

    const q = (panel.querySelector('#wlpro-filter').value || '').trim().toUpperCase();
    filtered = list.symbols.filter(s => !q || s.toUpperCase().includes(q));
    activeIdx = -1;
    countEl.textContent = `${filtered.length} symbol${filtered.length !== 1 ? 's' : ''}`;

    if (!filtered.length) {
      listEl.innerHTML = `<div class="wlpro-empty"><div class="wlpro-empty-icon">📋</div><p>${q ? 'No matches' : 'Empty watchlist.<br>Click ＋ to add symbols.'}</p></div>`;
      return;
    }

    listEl.innerHTML = '';
    filtered.forEach((sym, idx) => {
      const [exchange, symbol] = sym.includes(':') ? sym.split(':') : ['', sym];
      const name = getDisplayName(sym);

      const item = document.createElement('div');
      item.className = 'wlpro-item';
      item.innerHTML = `
        <div class="wlpro-item-info">
          <span class="wlpro-item-sym">${symbol}</span>
          <span class="wlpro-item-exch">${exchange}${name ? ' · ' + name : ''}</span>
        </div>
        <button class="wlpro-rm" data-sym="${sym}" title="Remove">✕</button>`;

      item.onclick = e => {
        if (e.target.classList.contains('wlpro-rm')) return;
        activeIdx = idx;
        highlight(panel.querySelectorAll('.wlpro-item'));
        navigateToSymbol(sym);
      };

      item.querySelector('.wlpro-rm').onclick = e => {
        e.stopPropagation();
        const i = list.symbols.indexOf(sym);
        if (i >= 0) { list.symbols.splice(i, 1); saveData(data, renderList); }
      };

      listEl.appendChild(item);
    });
  }

  // ─── Add Symbol Modal ───
  function showAddModal() {
    removeModals();
    const ov = document.createElement('div');
    ov.className = 'wlpro-overlay';
    ov.innerHTML = `
      <div class="wlpro-modal">
        <div class="wlpro-modal-hdr"><span>Add Symbol</span><button class="wlpro-modal-x">✕</button></div>
        <div class="wlpro-modal-body" style="padding:0">
          <div style="padding:12px 14px"><input id="wlpro-addsearch" type="text" placeholder="Search: HDFC, RELIANCE, TCS…" autofocus></div>
          <div id="wlpro-addresults" style="max-height:300px;overflow-y:auto;padding:0 4px 8px"></div>
        </div>
      </div>`;

    ov.querySelector('.wlpro-modal-x').onclick = () => ov.remove();
    ov.onclick = e => { if (e.target === ov) ov.remove(); };

    const input = ov.querySelector('#wlpro-addsearch');
    const results = ov.querySelector('#wlpro-addresults');

    function render() {
      const q = input.value.trim();
      if (q.length < 1) { results.innerHTML = '<div style="padding:12px;color:#888;font-size:13px">Type to search 7,000+ instruments…</div>'; return; }
      const matches = searchInstruments(q, 40);
      if (!matches.length) { results.innerHTML = `<div style="padding:12px;color:#888;font-size:13px">No matches for "${q}"</div>`; return; }

      const activeList = data.lists[data.activeIndex];
      results.innerHTML = '';
      matches.forEach(key => {
        const [exch, sym] = key.includes(':') ? key.split(':') : ['', key];
        const name = getDisplayName(key);
        const added = activeList.symbols.includes(key);

        const row = document.createElement('div');
        row.className = 'wlpro-search-row';
        row.innerHTML = `
          <div><div class="wlpro-sr-sym">${sym}</div><div class="wlpro-sr-exch">${exch}${name ? ' · ' + name : ''}</div></div>
          <button class="wlpro-sr-btn ${added ? 'added' : ''}" ${added ? 'disabled' : ''}>${added ? '✓ Added' : '+ Add'}</button>`;

        if (!added) {
          row.querySelector('button').onclick = e => {
            e.stopPropagation();
            activeList.symbols.push(key);
            saveData(data, () => { renderList(); render(); });
          };
        }
        results.appendChild(row);
      });
    }

    let timer;
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(render, 80); };
    input.onkeydown = e => { if (e.key === 'Escape') ov.remove(); };

    panel.appendChild(ov);
    setTimeout(() => input.focus(), 50);
    render();
  }

  // ─── Import Modal ───
  function showImportModal() {
    removeModals();
    const ov = document.createElement('div');
    ov.className = 'wlpro-overlay';
    ov.innerHTML = `
      <div class="wlpro-modal">
        <div class="wlpro-modal-hdr"><span>Import Symbols</span><button class="wlpro-modal-x">✕</button></div>
        <div class="wlpro-modal-body">
          <textarea id="wlpro-importtext" placeholder="Paste symbols, one per line&#10;e.g.&#10;NSE:HDFCBANK&#10;NSE:RELIANCE&#10;NSE:TCS"></textarea>
          <div class="wlpro-hint">One symbol per line in EXCHANGE:SYMBOL format</div>
        </div>
        <div class="wlpro-modal-ftr">
          <button class="wlpro-btn-sec wlpro-cancel">Cancel</button>
          <button class="wlpro-btn-pri" id="wlpro-importgo">Import</button>
        </div>
      </div>`;

    ov.querySelector('.wlpro-modal-x').onclick = () => ov.remove();
    ov.querySelector('.wlpro-cancel').onclick = () => ov.remove();
    ov.onclick = e => { if (e.target === ov) ov.remove(); };

    ov.querySelector('#wlpro-importgo').onclick = () => {
      const lines = ov.querySelector('#wlpro-importtext').value.split('\n').map(l => l.trim().toUpperCase()).filter(Boolean);
      if (!lines.length) return;
      const list = data.lists[data.activeIndex];
      let added = 0;
      lines.forEach(s => { if (!list.symbols.includes(s)) { list.symbols.push(s); added++; } });
      saveData(data, () => { renderList(); ov.remove(); showToast(`Imported ${added} symbols`); });
    };

    panel.appendChild(ov);
    setTimeout(() => ov.querySelector('#wlpro-importtext').focus(), 50);
  }

  function removeModals() { if (panel) panel.querySelectorAll('.wlpro-overlay').forEach(e => e.remove()); }

  // ─── Message Listener ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'toggle-watchlist-panel') {
      const v = toggle();
      sendResponse({ visible: v });
    }
    return true;
  });

  // ─── Init ───
  loadInstruments().then(() => {
    createPanel(); // pre-create hidden panel
  });

})();
