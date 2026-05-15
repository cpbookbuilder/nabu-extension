// Generate a unique device ID on first install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('device_id', ({ device_id }) => {
    if (!device_id) {
      chrome.storage.local.set({ device_id: crypto.randomUUID() });
    }
  });
});

// Listens for openAndScroll requests from the popup/history page.
// Runs as a service worker so it stays alive after the popup closes.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Fetch KaTeX from CDN — content scripts can't do this due to page CSP
  if (msg.type === 'fetchKaTeX') {
    fetch('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js')
      .then(r => r.text())
      .then(text => sendResponse(text))
      .catch(() => sendResponse(null));
    return true; // keep channel open for async response
  }

  if (msg.type !== 'openAndScroll') return;
  const { url, threadId } = msg;

  chrome.tabs.create({ url }, tab => {
    let attempts = 0;

    const listener = (tabId, info) => {
      if (tabId !== tab.id || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      trySend();
    };
    chrome.tabs.onUpdated.addListener(listener);

    function trySend() {
      if (attempts >= 10) return;
      attempts++;
      chrome.tabs.sendMessage(tab.id, { type: 'scrollToThread', threadId }, () => {
        // If the content script isn't ready yet, retry
        if (chrome.runtime.lastError) setTimeout(trySend, 1000);
      });
    }
  });
});
