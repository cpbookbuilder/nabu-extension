// Generate a unique device ID on first install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('device_id', ({ device_id }) => {
    if (!device_id) {
      chrome.storage.local.set({ device_id: crypto.randomUUID() });
    }
  });
  migrateLegacyTodosAndReminders();
});

// One-shot migration for users updating from <v1.3. The Todo and Saved
// concepts were removed in favour of Notes; each old entry becomes a note
// (with an empty body — they had no body in the old model). We append to
// the history index and per-URL bucket so existing pages re-highlight on
// revisit, then delete the old arrays so the migration can't run twice.
async function migrateLegacyTodosAndReminders() {
  try {
    const { todos = [], reminders = [], _notes_migrated_v1_3 } =
      await chrome.storage.local.get(['todos', 'reminders', '_notes_migrated_v1_3']);
    if (_notes_migrated_v1_3) return;
    if (!todos.length && !reminders.length) {
      await chrome.storage.local.set({ _notes_migrated_v1_3: true });
      return;
    }

    const legacy = [...todos, ...reminders].filter(e => e && e.url && e.anchor);
    const now = Date.now();
    const newId = () => 't_' + now + '_' + Math.random().toString(36).slice(2, 6);

    // Group by per-URL bucket (the threads:<base-url> keys content.js uses).
    const byBucket = new Map();
    const historyEntries = [];
    for (const e of legacy) {
      const baseUrl = String(e.url).split('#')[0];
      const id = e.id || newId();
      const record = {
        id, kind: 'note',
        anchor: e.anchor,
        color: '#b06000',
        pageContext: { surroundingText: e.surroundingText || '' },
        messages: [],
        noteText: '',
        createdAt: e.createdAt || now,
        savedAt: now,
      };
      const key = 'threads:' + baseUrl;
      if (!byBucket.has(key)) byBucket.set(key, []);
      byBucket.get(key).push(record);

      historyEntries.push({
        id, kind: 'note',
        url: baseUrl,
        pageTitle: e.pageTitle || '',
        anchor: String(e.anchor).slice(0, 120),
        surroundingText: (e.surroundingText || '').slice(0, 300),
        firstQuestion: '',
        questionCount: 0,
        noteText: '',
        createdAt: e.createdAt || now,
        savedAt: now,
      });
    }

    for (const [key, records] of byBucket) {
      const existing = (await chrome.storage.local.get(key))[key] || [];
      const existingIds = new Set(existing.map(r => r.id));
      const fresh = records.filter(r => !existingIds.has(r.id));
      await chrome.storage.local.set({ [key]: [...existing, ...fresh] });
    }

    const { history = [] } = await chrome.storage.local.get('history');
    const historyIds = new Set(history.map(h => h.id));
    const freshHistory = historyEntries.filter(h => !historyIds.has(h.id));
    await chrome.storage.local.set({
      history: [...freshHistory, ...history].slice(0, 200),
      _notes_migrated_v1_3: true,
    });
    await chrome.storage.local.remove(['todos', 'reminders']);
  } catch (e) {
    console.warn('[Nabu] note migration failed:', e);
  }
}

// Listens for openAndScroll requests from the popup/history page.
// Runs as a service worker so it stays alive after the popup closes.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'openDashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    return;
  }
  if (msg.type === 'openUrl') {
    // Only open https URLs — guards against a malformed/hostile backend
    // response trying to open javascript:, data:, or file: schemes.
    try {
      if (new URL(msg.url).protocol === 'https:') chrome.tabs.create({ url: msg.url });
    } catch (_) {}
    return;
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
