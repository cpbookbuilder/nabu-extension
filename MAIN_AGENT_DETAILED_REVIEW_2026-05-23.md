# Main Agent Detailed Review (Backend + Chrome Extension)

## Scope

Reviewed current repository state for production and Chrome Web Store readiness:
- Backend: `backend/main.py`, `backend/extension_routes.py`, `backend/db.py`, `backend/db_models.py`, `backend/pages_routes.py`, `backend/admin_routes.py`
- Extension: `chrome-extension/manifest.json`, `content.js`, `popup.js`, `dashboard.js`, `background.js`
- Docs consistency: `README.md`, `PRODUCTION.md`, `TODO.md`

This review is focused on correctness, security/privacy risk, reliability, and policy/documentation alignment.

---

## Critical

### 1) `/api/extension/restore` allows entitlement takeover via email-only restore

**Problem**
- `restore()` transfers paid subscription state based only on `{email, device_id}` with no ownership verification.

**Impact**
- Anyone who knows/guesses a subscriber email can move Pro entitlement to their own device.
- This is both a security and billing abuse vector.

**Evidence**
- `backend/extension_routes.py` `restore()`:
  - lookup by `ExtensionUser.email`
  - if subscribed, copy `subscribed`, `email`, `stripe_customer_id` to target device
  - detach source device subscription

**Fix guidance**
- Require proof of email ownership before transfer:
  - magic-link / OTP flow, or Stripe customer-portal verification.
- Keep anti-enumeration generic messaging for unverified attempts.
- Treat restore as a verified recovery flow, not an unauthenticated transfer API.

---

### 2) SPA route change persistence bug can save to wrong page key (data integrity risk)

**Problem**
- On client-side navigation, `_onLocationChange()` updates URL state first, then closes threads.
- `closeThread()` triggers `scheduleSave()`, and `saveThreads()` writes using `pageKey()` derived from current URL.

**Impact**
- Data from the departing route can be written under the new route key, or in-flight edits can be dropped.
- Most visible on SPA-heavy sites (Gemini/Notion/GitHub-like flows).

**Evidence**
- `chrome-extension/content.js`:
  - `_onLocationChange()` updates `_lastUrl` then closes threads
  - `closeThread()` -> `scheduleSave()` -> `saveThreads()` -> `pageKey()`

**Fix guidance**
- Snapshot and flush threads against the **old** URL key before changing route context.
- Add immediate save flush on route transition, not only debounced save.

---

## High

### 3) Retention policy says “30 days inactivity” but purge logic uses `created_at`

**Problem**
- Privacy policy states retention is based on inactivity.
- Free-tier purge class currently uses `ExtensionUser.created_at < cutoff`.

**Impact**
- Active users older than 30 days from install can be purged despite recent use.
- Compliance text and behavior are misaligned.

**Evidence**
- Policy: `backend/pages_routes.py` retention section.
- Code: `backend/extension_routes.py` `purge_old_data()` class-2 predicate uses `created_at`.

**Fix guidance**
- Add `last_seen_at` and update on usage/register/annotate.
- Purge based on last activity timestamp, not account creation time.

---

### 4) Stripe cancellation in delete-account only targets `status="active"`

**Problem**
- Deletion path only lists/cancels active subscriptions.

**Impact**
- Non-active but still billing-relevant states (`trialing`, potentially `past_due`) can be missed.
- Users may still have billing artifacts after account deletion.

**Evidence**
- `backend/extension_routes.py` `delete_account()`: `stripe.Subscription.list(..., status="active")`

**Fix guidance**
- Cancel all non-terminal subscription states for the customer (not just active).
- Add reconciliation/job for Stripe cancellation failures.

---

### 5) Restore response still leaks entitlement existence through `restored` boolean

**Problem**
- API uses generic human message but returns `restored: true/false`.
- Clients branch on this field.

**Impact**
- Enables subscription existence probing for an email.
- Increases exploitability of restore takeover issue.

**Evidence**
- `backend/extension_routes.py` `restore()` returns `restored`.
- `chrome-extension/popup.js` and `dashboard.js` branch on `data.restored`.

**Fix guidance**
- For unverified restore attempts, return uniform response shape/result.
- Only return positive status/token after ownership verification.

---

### 6) Popup/dashboard session state can go stale after JWT expiry

**Problem**
- Popup/dashboard depend on stored JWT but do not proactively re-register session.
- Content script handles JWT refresh path during annotate usage only.

**Impact**
- Account/usage/upgrade UI may appear disconnected until user asks a question from a page.

**Evidence**
- `popup.js`/`dashboard.js` read `annotate_jwt` and bail if missing/invalid.
- `content.js` clears JWT on 401 and re-establishes session via `getSession()` when asking.

**Fix guidance**
- Implement shared `ensureSession()` used by popup, dashboard, and content.
- Refresh token once on 401 for account/billing actions.

---

### 7) Debounced persistence without unload flush risks data loss

**Problem**
- Thread saves are debounced (~800ms) and there is no explicit flush on `pagehide`/`beforeunload`.

**Impact**
- Recent edits can be lost on quick navigation/reload/tab close.

**Evidence**
- `chrome-extension/content.js`: `scheduleSave()` only; no unload/pagehide flush path.

**Fix guidance**
- Add `flushSave()` on `pagehide` and route transitions.
- Save user message immediately when sent, then update on stream completion.

---

## Medium

### 8) CORS docs are out of sync with implementation

**Problem**
- `PRODUCTION.md` claims restricted CORS.
- `backend/main.py` intentionally uses `allow_origins=["*"]` due MV3 host-page origin behavior.

**Impact**
- Security/compliance docs drift.
- Can confuse release and security review.

**Fix guidance**
- Update `PRODUCTION.md` to match runtime behavior and threat model.

---

### 9) README repo structure is stale (`history.*` listed, `dashboard.*` exists)

**Problem**
- README still references `history.html/js`.
- Current extension uses `dashboard.html/js`.

**Impact**
- Developer onboarding confusion and docs credibility loss.

**Fix guidance**
- Update `README.md` repo structure and any narrative references.

---

### 10) Privacy “Your rights” copy is ambiguous vs immediate in-extension delete

**Problem**
- Policy says email deletion requests fulfilled within 7 days.
- Product now supports immediate self-serve deletion.

**Impact**
- Not a direct bug, but policy wording is incomplete and can confuse users/reviewers.

**Fix guidance**
- Clarify both paths:
  - immediate in-extension deletion
  - email support SLA for manual requests.

---

### 11) Hash-router URL keying still conflates route state

**Problem**
- `pageKey()` strips hash entirely.

**Impact**
- Hash-routed pages can share storage buckets, causing wrong restore behavior.

**Evidence**
- `chrome-extension/content.js` `pageKey()`.

**Fix guidance**
- Normalize keying by router-aware URL (include hash when route is hash-based).

---

### 12) Runtime KaTeX CSS fetch adds external dependency surface

**Problem**
- KaTeX CSS/fonts are fetched from jsDelivr at runtime.

**Impact**
- Extra network dependency and disclosure complexity.

**Fix guidance**
- Bundle CSS/fonts locally in extension package.

---

## Lower-priority hardening

- Replace in-memory rate limit buckets with shared store (Redis/DB) for multi-instance deployments.
- Add webhook/restore/purge tests in backend suite (current tests are strong for core annotate paths but thin for billing/recovery/retention transitions).
- Consider token versioning/shorter token TTL for stronger revocation guarantees.
- Add failure feedback for storage write failures in content script (avoid silent data-loss conditions).

---

## What looks solid

- Backend now has fail-fast env validation, structured logging, request IDs, and `/healthz`.
- Annotate flow includes reserve-and-refund behavior for upstream failure before first token.
- Delete-account UX properly surfaces Stripe cancellation failure state to user.
- Retention logic has a canceled-subscriber path via `cancelled_at`.
- Extension UX and persistence model are much improved (dashboard live updates, clearer clear-all behavior, better inline guidance).
- Asset files required by manifest are present in tracked files.

---

## Recommended execution order for the main coding agent

1. Lock down `/restore` with verified ownership recovery flow (critical).
2. Fix SPA route-transition persistence and add flush-save on navigation/unload.
3. Align retention implementation to true inactivity semantics.
4. Expand Stripe cancellation coverage in delete-account flow.
5. Unify session-refresh logic for popup/dashboard/content actions.
6. Clean documentation/policy drift (`README`, `PRODUCTION`, privacy copy).

