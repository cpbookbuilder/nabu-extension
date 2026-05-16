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
