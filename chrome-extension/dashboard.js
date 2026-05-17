const BACKEND_URL = 'https://nabu-extension-production.up.railway.app';

let currentTab = 'threads';
let allData = [];

// ── Account section ────────────────────────────────────────────────────────

async function loadAccount() {
  const summary = document.getElementById('usage-summary');
  const badge   = document.getElementById('plan-badge');
  const barWrap = document.getElementById('usage-bar-wrap');
  const fill    = document.getElementById('usage-fill');
  const upgrade = document.getElementById('btn-upgrade');
  const fine    = document.getElementById('upgrade-fineprint');
  const manage  = document.getElementById('btn-manage');

  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) {
    summary.textContent = 'Not connected yet — open a page and ask a question.';
    barWrap.style.display = 'none';
    upgrade.hidden = true; fine.hidden = true; manage.hidden = true;
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/usage`, {
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    if (!res.ok) return;
    const { count, limit, subscribed, remaining } = await res.json();

    if (subscribed) {
      badge.textContent = 'Pro ✓';
      badge.className = 'plan-badge badge-pro';
      summary.textContent = 'Unlimited access';
      summary.className = 'pro-text';
      barWrap.style.display = 'none';
      upgrade.hidden = true; fine.hidden = true;
      manage.hidden = false;
    } else {
      badge.textContent = 'Free';
      badge.className = 'plan-badge badge-free';
      summary.className = 'usage-text';
      const pct = Math.min(100, (count / limit) * 100);
      fill.style.width = `${pct}%`;
      fill.classList.toggle('warn', remaining === 0);
      barWrap.style.display = 'block';
      if (remaining === 0) {
        const now = new Date();
        const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const hoursLeft = Math.ceil((midnight - now) / 3600000);
        summary.textContent = hoursLeft <= 1 ? 'Daily limit reached — resets in <1h' : `Daily limit reached — resets in ${hoursLeft}h`;
      } else {
        summary.textContent = `${count} of ${limit} free questions used today`;
      }
      upgrade.hidden = false; fine.hidden = false;
      manage.hidden = true;
    }
  } catch (_) {}
}

async function upgrade() {
  const btn = document.getElementById('btn-upgrade');
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) return;
  btn.textContent = 'Opening checkout…'; btn.disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/create-checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || `Server error ${res.status}`); }
    const { url } = await res.json();
    chrome.tabs.create({ url });
  } catch (err) {
    btn.textContent = `Failed: ${err.message}`;
    setTimeout(() => { btn.textContent = '⚡ Upgrade — $4.99/mo'; btn.disabled = false; }, 3000);
    return;
  }
  btn.textContent = '⚡ Upgrade — $4.99/mo'; btn.disabled = false;
}

async function manageSubscription() {
  const btn = document.getElementById('btn-manage');
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) return;
  btn.textContent = 'Opening…'; btn.disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/manage-subscription`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || `Server error ${res.status}`); }
    const { url } = await res.json();
    chrome.tabs.create({ url });
  } catch (err) {
    btn.textContent = `Couldn't open: ${err.message}`;
    setTimeout(() => { btn.textContent = 'Manage subscription'; btn.disabled = false; }, 3000);
    return;
  }
  btn.textContent = 'Manage subscription'; btn.disabled = false;
}

async function restore() {
  const email = document.getElementById('restore-email').value.trim();
  const msg = document.getElementById('restore-msg');
  if (!email) return;
  const { device_id } = await chrome.storage.local.get('device_id');
  if (!device_id) { msg.textContent = 'Could not read device ID.'; msg.style.color = '#f28b82'; return; }
  msg.textContent = 'Checking…'; msg.style.color = '#9aa0a6';
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, device_id }),
    });
    const data = await res.json();
    if (!res.ok || !data.restored) {
      msg.textContent = 'If a subscription exists for this email, it has been restored.';
      msg.style.color = '#9aa0a6';
      return;
    }
    await chrome.storage.local.set({ annotate_jwt: data.token });
    msg.textContent = '✓ Subscription restored!';
    msg.style.color = '#81c995';
    loadAccount();
  } catch (_) {
    msg.textContent = 'Something went wrong. Try again.';
    msg.style.color = '#f28b82';
  }
}

async function deleteAccount() {
  const msg = document.getElementById('delete-msg');
  const btn = document.getElementById('btn-delete');
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) { await clearAllLocalData(); msg.textContent = '✓ Local data cleared.'; msg.style.color = '#81c995'; return; }
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json().catch(() => ({}));
    await clearAllLocalData();
    if (data.stripe_cancelled === false) {
      msg.innerHTML = '⚠ Data deleted, but we could not cancel your Pro subscription. Email <a href="mailto:nabu.extension@gmail.com" style="color:#f6c344;">nabu.extension@gmail.com</a> to confirm cancellation.';
      msg.style.color = '#fdd663';
    } else {
      const tail = data.stripe_cancelled === true ? ' Your Pro subscription was cancelled.' : '';
      msg.textContent = `✓ All data deleted.${tail}`;
      msg.style.color = '#81c995';
    }
    loadAccount();
    load();
  } catch (err) {
    msg.textContent = `Delete failed: ${err.message}`;
    msg.style.color = '#f28b82';
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm delete';
  }
}

async function clearAllLocalData() {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(k =>
    k.startsWith('threads:') || ['history', 'todos', 'reminders', 'annotate_jwt', 'device_id'].includes(k)
  );
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
}

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

// ── Account UI wiring ──────────────────────────────────────────────────────

document.getElementById('btn-upgrade').addEventListener('click', upgrade);
document.getElementById('btn-manage').addEventListener('click', manageSubscription);
document.getElementById('btn-restore').addEventListener('click', restore);
document.getElementById('btn-delete').addEventListener('click', deleteAccount);

document.getElementById('restore-toggle').addEventListener('click', () => {
  document.getElementById('restore-form').classList.toggle('open');
});
document.getElementById('delete-toggle').addEventListener('click', () => {
  document.getElementById('delete-form').classList.toggle('open');
});

loadAccount();
load();
