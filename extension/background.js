// Click extension icon → toggle the watchlist panel
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes('tv.upstox.com')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggle-watchlist-panel' });
  } catch (e) {
    // Content script not yet loaded — inject it
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['panel.css'] });
    setTimeout(() => chrome.tabs.sendMessage(tab.id, { action: 'toggle-watchlist-panel' }).catch(() => {}), 500);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'change-upstox-chart' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: (isin, symbolName) => {
        const tvIframe = document.querySelectorAll('iframe')[0];
        if (!tvIframe) return console.error('iframe not found');

        const api = tvIframe.contentWindow?.tradingViewApi;
        if (!api) return console.error('tradingViewApi not found');

        const tvSymbol = `NSE_EQ_TOKEN_${isin}:${symbolName} EQ`;
        api.activeChart().setSymbol(tvSymbol, () => {
          console.log('✅ Chart changed to:', api.activeChart().symbol());
        });
      },
      args: [msg.isin, msg.symbolName]
    }).catch(e => console.error("Script injection failed:", e));
  }
});
