// BACKEND_URL, ensureSession(), and apiFetch() come from session.js (loaded first).

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  loadUsage();

  document.getElementById('open-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

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
});

// ── Usage ──────────────────────────────────────────────────────────────────

async function loadUsage() {
  try {
    // ensureSession (via apiFetch) registers a device + token on demand and
    // refreshes once on 401, so the popup reflects real state instead of a
    // stale "not connected" until the user visits a content page.
    const res = await apiFetch('/api/extension/usage');
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
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const res = await apiFetch('/api/extension/manage-subscription', { method: 'POST' });
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
  btn.textContent = 'Opening checkout…';
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/extension/create-checkout', { method: 'POST' });
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
  // New flow (post-2026-05-23): restore is two-step. Step 1 returns a Stripe
  // Customer Portal URL — Stripe verifies the email via OTP, then redirects to
  // our /restore-complete which transfers Pro to this device. We never see the
  // OTP; we trust Stripe's auth as proof of email ownership.
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
      msg.innerHTML = 'Opened the verification link in a new tab. After you finish in Stripe, refresh this popup.';
      msg.style.color = '#9aa0a6';
      return;
    }
    // Generic response — either no match, or service unavailable.
    msg.textContent = data.message || 'If a subscription exists for this email, you\'ll receive a verification link.';
    msg.style.color = '#9aa0a6';
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
  // Clear everything Nabu has stored locally: per-URL thread buckets, history,
  // device id, JWT, migration flag — leave a fresh slate.
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(k =>
    k.startsWith('threads:') || ['history', 'annotate_jwt', 'device_id', '_notes_migrated_v1_3'].includes(k)
  );
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
}

