const BACKEND_URL = 'https://annotate-ai-production.up.railway.app';

// ── Tab switching ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.getElementById('panel-account').hidden = target !== 'account';
    document.getElementById('panel-history').hidden = target !== 'history';
    if (target === 'history') renderHistory();
    if (target === 'account') loadUsage();
  });
});

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  renderHistory();

  const { model = 'gpt-4o-mini' } = await chrome.storage.sync.get('model');
  document.getElementById('model').value = model;

  document.getElementById('btn-save-model').addEventListener('click', async () => {
    await chrome.storage.sync.set({ model: document.getElementById('model').value });
    const s = document.getElementById('saved');
    s.style.display = 'block';
    setTimeout(() => { s.style.display = 'none'; }, 2000);
  });

  document.getElementById('btn-upgrade').addEventListener('click', upgrade);

  document.getElementById('restore-toggle').addEventListener('click', () => {
    const form = document.getElementById('restore-form');
    form.style.display = form.style.display === 'block' ? 'none' : 'block';
  });

  document.getElementById('btn-restore').addEventListener('click', restore);

  document.getElementById('see-all').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  });
});

// ── Usage ──────────────────────────────────────────────────────────────────

async function loadUsage() {
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) {
    document.getElementById('usage-text').textContent = 'Not connected yet — open a page and ask a question.';
    return;
  }
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/usage`, {
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    if (!res.ok) return;
    const { count, limit, subscribed, remaining } = await res.json();

    const badge = document.getElementById('plan-badge');
    if (subscribed) {
      badge.textContent = 'Pro ✓';
      badge.className = 'status-badge badge-pro';
      document.getElementById('usage-section').innerHTML = '<div class="usage-text" style="color:#81c995">Unlimited access</div>';
      document.getElementById('btn-upgrade').hidden = true;
    } else {
      const pct = Math.min(100, (count / limit) * 100);
      const fill = document.getElementById('usage-fill');
      fill.style.width = `${pct}%`;
      fill.classList.toggle('warn', remaining === 0);
      document.getElementById('usage-text').textContent =
        remaining === 0 ? `Limit reached — resets midnight UTC` : `${count} of ${limit} free questions used today`;
      document.getElementById('btn-upgrade').hidden = false;
    }
  } catch (_) {}
}

// ── Upgrade ────────────────────────────────────────────────────────────────

async function upgrade() {
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) return;
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/create-checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    const { url } = await res.json();
    chrome.tabs.create({ url });
  } catch (_) {}
}

// ── Restore purchase ───────────────────────────────────────────────────────

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
    if (!res.ok) {
      msg.textContent = 'No active subscription found for this email.';
      msg.style.color = '#f28b82';
      return;
    }
    const { token } = await res.json();
    await chrome.storage.local.set({ annotate_jwt: token });
    msg.textContent = '✓ Subscription restored!';
    msg.style.color = '#81c995';
    document.getElementById('restore-form').style.display = 'none';
    loadUsage();
  } catch (_) {
    msg.textContent = 'Something went wrong. Try again.';
    msg.style.color = '#f28b82';
  }
}

// ── History ────────────────────────────────────────────────────────────────

async function renderHistory() {
  const list = document.getElementById('history-list');
  const { history = [] } = await chrome.storage.local.get('history');
  if (!history.length) {
    list.innerHTML = '<p class="empty">No threads yet.<br>Select text on any page to start.</p>';
    return;
  }
  const recent = history.slice(0, 3);
  list.innerHTML = recent.map(e => `
    <div class="h-entry">
      <div class="h-anchor">"${escapeHtml(e.anchor)}"</div>
      <div class="h-question">${escapeHtml(e.firstQuestion || '(no question yet)')}</div>
      <div class="h-meta">
        <span class="h-url" title="${escapeAttr(e.url)}">${shortUrl(e.url)}</span>
        <span>${relativeDate(e.savedAt)}</span>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.h-entry').forEach((el, i) => {
    el.addEventListener('click', () =>
      chrome.runtime.sendMessage({ type: 'openAndScroll', url: recent[i].url, threadId: recent[i].id })
    );
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 20 ? u.pathname.slice(0, 20) + '…' : u.pathname);
  } catch (_) { return url.slice(0, 35); }
}
function relativeDate(ts) {
  const diff = Date.now() - ts, m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
