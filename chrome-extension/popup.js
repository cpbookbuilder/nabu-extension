const BACKEND_URL = 'https://nabu-extension-production.up.railway.app';

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  loadUsage();
  renderHistory();

  document.getElementById('btn-upgrade').addEventListener('click', upgrade);
  document.getElementById('btn-manage').addEventListener('click', manageSubscription);

  document.getElementById('restore-toggle').addEventListener('click', () => {
    const form = document.getElementById('restore-form');
    form.style.display = form.style.display === 'block' ? 'none' : 'block';
  });

  document.getElementById('btn-restore').addEventListener('click', restore);

  document.getElementById('delete-toggle').addEventListener('click', () => {
    const form = document.getElementById('delete-form');
    form.style.display = form.style.display === 'block' ? 'none' : 'block';
  });

  document.getElementById('btn-delete').addEventListener('click', deleteAccount);

  document.getElementById('see-all').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });
});

// ── Usage ──────────────────────────────────────────────────────────────────

async function loadUsage() {
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) {
    document.getElementById('usage-text').textContent = 'Not connected yet — open a page and ask a question.';
    document.getElementById('btn-upgrade').hidden = true;
    document.getElementById('upgrade-fineprint').hidden = true;
    document.getElementById('btn-manage').hidden = true;
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
      document.getElementById('upgrade-fineprint').hidden = true;
      document.getElementById('btn-manage').hidden = false;
    } else {
      const pct = Math.min(100, (count / limit) * 100);
      const fill = document.getElementById('usage-fill');
      fill.style.width = `${pct}%`;
      fill.classList.toggle('warn', remaining === 0);
      let usageText = `${count} of ${limit} free questions used today`;
      if (remaining === 0) {
        const now = new Date();
        const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const hoursLeft = Math.ceil((midnight - now) / 3600000);
        usageText = hoursLeft <= 1 ? 'Limit reached — resets in less than 1 hour' : `Limit reached — resets in ${hoursLeft} hours`;
      }
      document.getElementById('usage-text').textContent = usageText;
      document.getElementById('btn-upgrade').hidden = false;
      document.getElementById('btn-upgrade').textContent = '⚡ Upgrade — $4.99/mo';
      document.getElementById('upgrade-fineprint').hidden = false;
      document.getElementById('btn-manage').hidden = true;
    }
  } catch (_) {}
}

// ── Manage subscription (Stripe Customer Portal) ───────────────────────────

async function manageSubscription() {
  const btn = document.getElementById('btn-manage');
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) return;
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/manage-subscription`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${res.status}`);
    }
    const { url } = await res.json();
    chrome.tabs.create({ url });
  } catch (err) {
    btn.textContent = `Couldn't open: ${err.message}`;
    setTimeout(() => { btn.textContent = 'Manage subscription'; btn.disabled = false; }, 3000);
    return;
  }
  btn.textContent = 'Manage subscription';
  btn.disabled = false;
}

// ── Upgrade ────────────────────────────────────────────────────────────────

async function upgrade() {
  const btn = document.getElementById('btn-upgrade');
  const usageText = document.getElementById('usage-text');
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) {
    if (usageText) usageText.textContent = 'Open any page and ask a question first to activate.';
    return;
  }
  btn.textContent = 'Opening checkout…';
  btn.disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/create-checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${res.status}`);
    }
    const { url } = await res.json();
    chrome.tabs.create({ url });
  } catch (err) {
    if (usageText) {
      usageText.textContent = `Upgrade failed: ${err.message}`;
      usageText.style.color = '#f28b82';
    }
  } finally {
    btn.textContent = '⚡ Upgrade — $4.99/mo';
    btn.disabled = false;
  }
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
    const data = await res.json();
    if (!res.ok || !data.restored) {
      msg.textContent = 'If a subscription exists for this email, it has been restored.';
      msg.style.color = '#9aa0a6';
      return;
    }
    await chrome.storage.local.set({ annotate_jwt: data.token });
    msg.textContent = '✓ Subscription restored!';
    msg.style.color = '#81c995';
    document.getElementById('restore-form').style.display = 'none';
    loadUsage();
  } catch (_) {
    msg.textContent = 'Something went wrong. Try again.';
    msg.style.color = '#f28b82';
  }
}

// ── Delete account ─────────────────────────────────────────────────────────

async function deleteAccount() {
  const msg = document.getElementById('delete-msg');
  const btn = document.getElementById('btn-delete');
  const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
  if (!annotate_jwt) {
    // No server record to delete — just clear local data.
    await clearAllLocalData();
    msg.textContent = '✓ Local data cleared.';
    msg.style.color = '#81c995';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const res = await fetch(`${BACKEND_URL}/api/extension/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${annotate_jwt}` },
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json().catch(() => ({}));
    await clearAllLocalData();
    document.getElementById('btn-upgrade').hidden = true;
    document.getElementById('usage-text').textContent = 'Account deleted. Re-open any page to start fresh.';
    // Surface Stripe outcome honestly. data.stripe_cancelled is:
    //   true  → server cancelled an active sub
    //   false → server tried but Stripe call failed (rare; user should follow up)
    //   undefined → no Stripe customer on file (free user) → nothing to cancel
    if (data.stripe_cancelled === false) {
      msg.innerHTML = '⚠ Data deleted, but we could not cancel your Pro subscription. Email <a href="mailto:nabu.extension@gmail.com" style="color:#f6c344;">nabu.extension@gmail.com</a> to confirm cancellation and avoid further charges.';
      msg.style.color = '#fdd663';
    } else {
      const tail = data.stripe_cancelled === true ? ' Your Pro subscription was cancelled.' : '';
      msg.textContent = `✓ All data deleted.${tail}`;
      msg.style.color = '#81c995';
    }
  } catch (err) {
    msg.textContent = `Delete failed: ${err.message}`;
    msg.style.color = '#f28b82';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm delete';
  }
}

async function clearAllLocalData() {
  // Clear everything Nabu has stored locally: threads, history, todos, reminders,
  // device id, JWT — leave a fresh slate.
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(k =>
    k.startsWith('threads:') || ['history', 'todos', 'reminders', 'annotate_jwt', 'device_id'].includes(k)
  );
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
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
