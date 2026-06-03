// BACKEND_URL, ensureSession(), and apiFetch() come from session.js (loaded first).

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

  try {
    // ensureSession (via apiFetch) registers + refreshes the token on demand,
    // so the account panel reflects real state instead of "not connected"
    // until the user visits a content page.
    const res = await apiFetch('/api/extension/usage');
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
  btn.textContent = 'Opening checkout…'; btn.disabled = true;
  try {
    const res = await apiFetch('/api/extension/create-checkout', { method: 'POST' });
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
  btn.textContent = 'Opening…'; btn.disabled = true;
  try {
    const res = await apiFetch('/api/extension/manage-subscription', { method: 'POST' });
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
  // Two-step flow: backend returns a Stripe Customer Portal URL we open in a
  // new tab. Stripe verifies the email; our /restore-complete transfers Pro.
  // No client-side token swap — the device's existing JWT just starts seeing
  // subscribed=true once /restore-complete commits.
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
    if (res.ok && data.verify_url) {
      chrome.tabs.create({ url: data.verify_url });
      msg.textContent = 'Opened the verification link in a new tab. After you finish in Stripe, refresh this page.';
      msg.style.color = '#9aa0a6';
      return;
    }
    msg.textContent = data.message || 'If a subscription exists for this email, you\'ll receive a verification link.';
    msg.style.color = '#9aa0a6';
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
    k.startsWith('threads:') || ['history', 'annotate_jwt', 'device_id', '_notes_migrated_v1_3'].includes(k)
  );
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
}

// ── Init ───────────────────────────────────────────────────────────────────

async function load() {
  const { history = [] } = await chrome.storage.local.get(['history']);

  // History contains both question threads (kind != 'note' or missing) and
  // notes (kind === 'note'). Split for the two tabs + stat tiles.
  const questionEntries = history.filter(h => h.kind !== 'note');
  const noteEntries     = history.filter(h => h.kind === 'note');

  // questionCount was added in v1.2 — older history entries fall back to 1.
  const totalQuestions = questionEntries.reduce((sum, h) => sum + (h.questionCount ?? 1), 0);
  document.getElementById('stat-questions').textContent = totalQuestions.toLocaleString();
  document.getElementById('stat-notes').textContent     = noteEntries.length.toLocaleString();

  const dataMap = { threads: questionEntries, notes: noteEntries };
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
    const labels = { threads: 'No questions yet.', notes: 'No notes yet.' };
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

  } else { // notes
    list.innerHTML = entries.map((e, i) => `
      <div class="entry" data-url="${escapeAttr(e.url)}" data-i="${i}">
        <div class="entry-anchor">"${escapeHtml(e.anchor)}"</div>
        ${(e.firstNote || e.noteText) ? `<div class="entry-question">${escapeHtml(e.firstNote || e.noteText)}${e.noteCount > 1 ? ` <span style="color:#9aa0a6;font-weight:400;">· +${e.noteCount - 1} more</span>` : ''}</div>` : '<div class="entry-question" style="color:#5f6368;font-style:italic;">(empty note)</div>'}
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
  }
}

// ── Clear button ───────────────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', async () => {
  // Both Questions and Notes live in the same per-URL threads:* buckets and
  // the same history index, so "Clear" removes the entries of the current
  // tab's kind from history; per-URL buckets are pruned to the other kind.
  const tabKind = currentTab === 'notes' ? 'note' : 'thread';
  const otherKind = currentTab === 'notes' ? 'thread' : 'note';
  const label = currentTab === 'notes' ? 'all notes' : 'all questions';
  if (!confirm(`Clear ${label}?`)) return;

  const all = await chrome.storage.local.get(null);
  const updates = {};
  // History: keep only entries that are NOT the current tab's kind.
  updates.history = (all.history || []).filter(h => (h.kind || 'thread') !== tabKind);
  // Per-URL threads:<url> buckets: drop records of this kind, keep the other.
  const threadKeys = Object.keys(all).filter(k => k.startsWith('threads:'));
  const keysToRemove = [];
  for (const k of threadKeys) {
    const next = (all[k] || []).filter(r => (r.kind || 'thread') !== tabKind);
    if (next.length === 0) keysToRemove.push(k);
    else updates[k] = next;
  }
  await chrome.storage.local.set(updates);
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
  // Suppress unused warning — otherKind documents the intent.
  void otherKind;
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

// Live-update stats + list when threads/todos/reminders change in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const touched = Object.keys(changes);
  if (touched.some(k => k === 'history' || k.startsWith('threads:'))) {
    load();
  }
});
