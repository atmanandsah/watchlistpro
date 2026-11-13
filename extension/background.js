// ─── Instrument Cache ───────────────────────────────────────────────────────
// Fetches fresh NSE + BSE equity listings from Upstox's public CDN and stores
// them in chrome.storage.local so new IPOs / listings are always available.

const INSTRUMENTS_CACHE_KEY = 'wlpro_instruments';
const REFRESH_ALARM          = 'wlpro-refresh-instruments';
const REFRESH_INTERVAL_DAYS  = 1; // re-fetch every day

const INSTRUMENT_URLS = {
  NSE: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  BSE: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
};

// Upstox serves raw gzip bytes (not Content-Encoding: gzip), so we decompress
// manually using DecompressionStream.  Falls back to plain .json() if the
// server ever switches to transparent Content-Encoding compression.
async function fetchGzip(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const clone = res.clone();
  try {
    const ds     = new DecompressionStream('gzip');
    const stream = res.body.pipeThrough(ds);
    return await new Response(stream).json();
  } catch (_) {
    // Server may have switched to transparent decompression
    return clone.json();
  }
}

async function fetchAndCacheInstruments() {
  console.log('[WatchlistPro] Refreshing instrument list…');
  const mapping = {};

  for (const [exchange, url] of Object.entries(INSTRUMENT_URLS)) {
    try {
      const rows = await fetchGzip(url);

      for (const item of rows) {
        const seg  = item.segment;

        // Keep only cash-equity segments
        if (seg === 'NSE_EQ') {
          if (!['EQ', 'SM'].includes(item.instrument_type)) continue;
        } else if (seg === 'BSE_EQ') {
          if (!['A', 'B', 'T', 'X', 'XT', 'E'].includes(item.instrument_type)) continue;
        } else {
          continue;
        }

        const sym  = item.trading_symbol;
        const isin = item.isin;
        if (!sym || !isin) continue;

        const exch = seg === 'BSE_EQ' ? 'BSE' : 'NSE';
        mapping[`${exch}:${sym}`] = {
          i: isin,
          n: item.name       || '',
          s: item.short_name || '',
        };
      }

      console.log(`[WatchlistPro] ${exchange}: processed`);
    } catch (err) {
      console.error(`[WatchlistPro] Failed to fetch ${exchange} instruments:`, err.message);
    }
  }

  const count = Object.keys(mapping).length;
  if (count < 500) {
    // Sanity check failed — don't overwrite good cached data with garbage
    console.warn('[WatchlistPro] Instrument count too low, aborting cache write:', count);
    return { success: false, count };
  }

  await chrome.storage.local.set({
    [INSTRUMENTS_CACHE_KEY]: {
      data:      mapping,
      timestamp: Date.now(),
      count,
    },
  });

  console.log(`[WatchlistPro] Cached ${count} instruments ✅`);

  // Tell any open Upstox tabs to reload the instrument list
  const tabs = await chrome.tabs.query({ url: 'https://tv.upstox.com/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { action: 'instruments-updated', count })
      .catch(() => {/* tab may not have content script yet */});
  }

  return { success: true, count };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Fetch immediately on first install / extension update
  fetchAndCacheInstruments();

  // Schedule periodic background refresh
  chrome.alarms.create(REFRESH_ALARM, {
    periodInMinutes: REFRESH_INTERVAL_DAYS * 24 * 60,
  });
});

// Also fetch on browser startup in case the alarm never fired
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(INSTRUMENTS_CACHE_KEY, result => {
    const cached = result[INSTRUMENTS_CACHE_KEY];
    const age    = cached ? Date.now() - cached.timestamp : Infinity;
    // Re-fetch if stale or missing
    if (age > REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000) {
      fetchAndCacheInstruments();
    }
  });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === REFRESH_ALARM) fetchAndCacheInstruments();
});

// ─── Message listener ────────────────────────────────────────────────────────

// Click extension icon → toggle the watchlist panel
chrome.action.onClicked.addListener(async tab => {
  if (!tab.url || !tab.url.includes('tv.upstox.com')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggle-watchlist-panel' });
  } catch (e) {
    // Content script not yet loaded — inject it
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['panel.css'] });
    setTimeout(() =>
      chrome.tabs.sendMessage(tab.id, { action: 'toggle-watchlist-panel' }).catch(() => {}),
    500);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── Chart change (called from content script via MAIN world injection) ──
  if (msg.action === 'change-upstox-chart' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world:  'MAIN',
      func: (isin, symbolName) => {
        const tvIframe = document.querySelectorAll('iframe')[0];
        if (!tvIframe) return console.error('iframe not found');
        const api = tvIframe.contentWindow?.tradingViewApi;
        if (!api)   return console.error('tradingViewApi not found');
        const tvSymbol = `NSE_EQ_TOKEN_${isin}:${symbolName} EQ`;
        api.activeChart().setSymbol(tvSymbol, () => {
          console.log('✅ Chart changed to:', api.activeChart().symbol());
        });
      },
      args: [msg.isin, msg.symbolName],
    }).catch(e => console.error('Script injection failed:', e));
  }

  // ── Manual instrument refresh triggered from the panel ──
  if (msg.action === 'refresh-instruments') {
    fetchAndCacheInstruments()
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ success: false }));
    return true; // keep channel open for async response
  }

  // ── Instruments status query (count + age) ──
  if (msg.action === 'get-instruments-status') {
    chrome.storage.local.get(INSTRUMENTS_CACHE_KEY, result => {
      const cached = result[INSTRUMENTS_CACHE_KEY];
      sendResponse(cached
        ? { count: cached.count, timestamp: cached.timestamp }
        : null);
    });
    return true;
  }
});
