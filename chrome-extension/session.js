// Shared session helpers for popup.js and dashboard.js. Loaded before them.
//
// Before this existed, the popup/dashboard read annotate_jwt directly and
// bailed if it was missing or expired — so they could show a stale/"not
// connected" state until the user asked a question on a content page (which
// is what re-established the session). ensureSession() registers a device +
// token on demand, and apiFetch() transparently refreshes once on a 401.

const BACKEND_URL = 'https://nabu-extension-production.up.railway.app';

async function ensureSession() {
  let { annotate_jwt, device_id } = await chrome.storage.local.get(['annotate_jwt', 'device_id']);
  if (!device_id) {
    device_id = crypto.randomUUID();
    await chrome.storage.local.set({ device_id });
  }
  if (annotate_jwt) return annotate_jwt;

  const res = await fetch(`${BACKEND_URL}/api/extension/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id }),
  });
  if (!res.ok) throw new Error(`register failed (${res.status})`);
  const { token } = await res.json();
  await chrome.storage.local.set({ annotate_jwt: token });
  return token;
}

// Authenticated fetch against the backend. Ensures a session first, and on a
// 401 (expired/invalid token) clears the token, re-registers, and retries
// exactly once so account/usage UI never gets stuck on a dead token.
async function apiFetch(path, opts = {}) {
  let token = await ensureSession();
  const build = t => ({ ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });

  let res = await fetch(`${BACKEND_URL}${path}`, build(token));
  if (res.status === 401) {
    await chrome.storage.local.remove('annotate_jwt');
    token = await ensureSession();
    res = await fetch(`${BACKEND_URL}${path}`, build(token));
  }
  return res;
}
