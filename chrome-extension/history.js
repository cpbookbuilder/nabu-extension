let currentTab = 'threads';
let allData = [];

// ── Init ───────────────────────────────────────────────────────────────────

async function load() {
  const { history = [], todos = [], reminders = [] } =
    await chrome.storage.local.get(['history', 'todos', 'reminders']);

  const dataMap = { threads: history, todos, reminders };
  allData = (dataMap[currentTab] || []).sort((a, b) =>
    (b.savedAt || b.createdAt || 0) - (a.savedAt || a.createdAt || 0) ||
    (b.createdAt || 0) - (a.createdAt || 0)
  );

  document.getElementById('tab-count').textContent =
    `${allData.length} item${allData.length !== 1 ? 's' : ''}`;

  render(applySearch(allData));
}

// ── Tab switching ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    document.getElementById('search').value = '';
    load();
  });
});

// ── Search ─────────────────────────────────────────────────────────────────

document.getElementById('search').addEventListener('input', e => {
  render(applySearch(allData, e.target.value.trim()));
});

function applySearch(data, q = '') {
  if (!q) return data;
  const lq = q.toLowerCase();
  return data.filter(e =>
    e.anchor?.toLowerCase().includes(lq) ||
    e.firstQuestion?.toLowerCase().includes(lq) ||
    e.surroundingText?.toLowerCase().includes(lq) ||
    e.url?.toLowerCase().includes(lq) ||
    e.pageTitle?.toLowerCase().includes(lq)
  );
}

// ── Render ─────────────────────────────────────────────────────────────────

function render(entries) {
  const list = document.getElementById('list');

  if (!entries.length) {
    const labels = { threads: 'No threads yet.', todos: 'No todos yet.', reminders: 'Nothing saved yet.' };
    list.innerHTML = `<p class="empty">${labels[currentTab]}<br>Select text on any page to get started.</p>`;
    return;
  }

  if (currentTab === 'threads') {
    list.innerHTML = entries.map((e, i) => `
      <div class="entry" data-url="${escapeAttr(e.url)}" data-i="${i}">
        <div class="entry-anchor">"${escapeHtml(e.anchor)}"</div>
        <div class="entry-question">${escapeHtml(e.firstQuestion || '(no question yet)')}</div>
        ${e.surroundingText ? `<div class="entry-context">${escapeHtml(e.surroundingText)}</div>` : ''}
        <div class="entry-meta">
          <span class="entry-url" title="${escapeAttr(e.url)}">${shortUrl(e.url)}</span>
          <span>${relativeDate(e.savedAt)}</span>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.entry').forEach((el, i) => {
      el.addEventListener('click', () =>
        chrome.runtime.sendMessage({ type: 'openAndScroll', url: entries[i].url, threadId: entries[i].id })
      );
    });

  } else if (currentTab === 'todos') {
    list.innerHTML = entries.map((e, i) => `
      <div class="item ${e.done ? 'done' : ''}" data-i="${i}">
        <input type="checkbox" class="item-check" ${e.done ? 'checked' : ''} data-i="${i}">
        <div class="item-body" data-i="${i}">
          <div class="item-anchor">"${escapeHtml(e.anchor)}"</div>
          ${e.surroundingText ? `<div class="item-text">${escapeHtml(e.surroundingText.slice(0, 160))}</div>` : ''}
          <div class="item-meta">
            <span class="item-url" title="${escapeAttr(e.url)}">${shortUrl(e.url)}</span>
            <span>${relativeDate(e.createdAt)}</span>
          </div>
        </div>
        <button class="item-del" data-i="${i}" title="Delete">×</button>
      </div>
    `).join('');

    list.querySelectorAll('.item-check').forEach(cb => {
      cb.addEventListener('change', async e => {
        e.stopPropagation();
        const i = parseInt(cb.dataset.i);
        const entry = entries[i];
        entry.done = cb.checked;
        await updateItem('todos', entry);
        load();
      });
    });

    list.querySelectorAll('.item-body').forEach(body => {
      body.addEventListener('click', () => {
        const entry = entries[parseInt(body.dataset.i)];
        chrome.tabs.create({ url: entry.url });
      });
    });

    list.querySelectorAll('.item-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await deleteItem('todos', entries[parseInt(btn.dataset.i)].id);
        load();
      });
    });

  } else { // reminders
    list.innerHTML = entries.map((e, i) => `
      <div class="item" data-i="${i}">
        <div class="reminder-dot"></div>
        <div class="item-body" data-i="${i}">
          <div class="item-anchor">"${escapeHtml(e.anchor)}"</div>
          ${e.surroundingText ? `<div class="item-text">${escapeHtml(e.surroundingText.slice(0, 160))}</div>` : ''}
          <div class="item-meta">
            <span class="item-url" title="${escapeAttr(e.url)}">${shortUrl(e.url)}</span>
            <span>${relativeDate(e.createdAt)}</span>
          </div>
        </div>
        <button class="item-del" data-i="${i}" title="Delete">×</button>
      </div>
    `).join('');

    list.querySelectorAll('.item-body').forEach(body => {
      body.addEventListener('click', () => {
        const entry = entries[parseInt(body.dataset.i)];
        chrome.tabs.create({ url: entry.url });
      });
    });

    list.querySelectorAll('.item-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await deleteItem('reminders', entries[parseInt(btn.dataset.i)].id);
        load();
      });
    });
  }
}

// ── Storage helpers ────────────────────────────────────────────────────────

async function updateItem(type, updated) {
  const { [type]: items = [] } = await chrome.storage.local.get(type);
  const next = items.map(it => it.id === updated.id ? updated : it);
  await chrome.storage.local.set({ [type]: next });
}

async function deleteItem(type, id) {
  const { [type]: items = [] } = await chrome.storage.local.get(type);
  await chrome.storage.local.set({ [type]: items.filter(it => it.id !== id) });
}

// ── Clear button ───────────────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', async () => {
  const labels = { threads: 'all threads (history + saved threads on every page)', todos: 'all todos', reminders: 'all saved-for-later items' };
  if (!confirm(`Clear ${labels[currentTab]}?`)) return;
  if (currentTab === 'threads') {
    // Clear both the recent-threads index and every per-URL thread blob.
    const all = await chrome.storage.local.get(null);
    const threadKeys = Object.keys(all).filter(k => k.startsWith('threads:'));
    await chrome.storage.local.remove(['history', ...threadKeys]);
  } else {
    await chrome.storage.local.set({ [currentTab]: [] });
  }
  load();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 24 ? u.pathname.slice(0, 24) + '…' : u.pathname);
  } catch (_) { return url.slice(0, 40); }
}

function relativeDate(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

load();
