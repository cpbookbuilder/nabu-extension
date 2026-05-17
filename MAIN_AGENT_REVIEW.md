# Nabu Chrome Web Store Readiness Review

## Scope and goal

This review compares `README.md` claims with the current implementation and flags issues that could cause Chrome Web Store rejection, policy/compliance risk, security incidents, or major user-facing bugs.

The goal is to give the main agent a prioritized fix plan before submission.

## Executive verdict

Core product behavior exists (inline threads, per-page persistence, quick actions, free-tier usage tracking, Stripe upgrade flow), but the current state is **not ready** for Chrome Web Store submission.

Top blockers:
- Missing files referenced by `manifest.json` (`katex.min.js`, all `icons/*`).
- Privacy/data-flow claims are inaccurate versus actual backend proxy behavior.
- Security/compliance gaps (default JWT secret fallback, retention mismatch, no self-serve delete UI).
- Functional mismatches with README promises (`exact anchor spot`, reminder semantics, history clearing behavior).

## Findings by severity

### Critical blockers (fix before any submission)

1) Missing packaged assets required by manifest
- `chrome-extension/manifest.json` references:
  - `katex.min.js`
  - `icons/icon16.png`, `icons/icon32.png`, `icons/icon48.png`, `icons/icon128.png`
- Current tree does not contain these files.
- Impact:
  - Extension can fail to load or fail store validation.
  - Broken icon assets are immediate quality/review problems.
- Required fix:
  - Add the missing files to `chrome-extension/`.
  - Verify zip package exactly matches manifest references.
  - Run a clean load test in `chrome://extensions`.

2) Privacy policy and README misrepresent data flow
- Current behavior: extension sends messages to backend (`/api/extension/annotate`), backend forwards to OpenAI.
- Current claims (README and `/privacy`) say selected text/questions go directly to OpenAI and Nabu servers never see content.
- This is inaccurate because backend receives/processes message payloads in transit.
- Impact:
  - High Chrome Web Store disclosure risk.
  - Potential legal/compliance and trust risk.
- Required fix:
  - Update all public copy (README, popup text, `/privacy`, landing page) to accurately describe:
    - extension -> Nabu backend -> OpenAI
    - content is not persisted by Nabu DB (if true), but is processed in request transit.
  - Ensure store listing privacy answers match this exact flow.

### High severity

3) Insecure JWT fallback in production path
- `backend/extension_routes.py` uses a hardcoded default secret when `JWT_SECRET` is absent.
- Impact:
  - Token forgery possible if misconfigured deployment reaches production.
- Required fix:
  - Remove fallback secret.
  - Fail startup (or reject auth endpoints) when `JWT_SECRET` is missing.

4) Data retention policy mismatch and missing scheduler
- `/privacy` says 30-day inactivity retention and email removal within 30 days after cancellation.
- Code cleanup helper uses 60/90-day windows and is not scheduled from `main.py`.
- Impact:
  - Published policy and actual behavior diverge.
- Required fix:
  - Choose one retention policy.
  - Align code and policy exactly.
  - Wire scheduled cleanup (cron/background scheduler).

5) Delete account flow incomplete for users
- Backend has `DELETE /api/extension/account`.
- Extension UI does not expose self-serve delete action.
- Impact:
  - Erasure claim is hard to exercise in-product.
- Required fix:
  - Add “Delete my data” in popup/settings with explicit confirmation.
  - Clear local extension storage on success.
  - Update copy to explain what is deleted locally vs server-side.

6) Account deletion does not address Stripe lifecycle
- Deletion removes DB records but does not cancel subscription on Stripe side.
- Impact:
  - Billing/user-support/privacy expectations mismatch.
- Required fix:
  - On delete account:
    - cancel active Stripe subscription (or require pre-cancel with clear UX and docs),
    - remove/disassociate Stripe customer linkage appropriately.
  - Update policy text accordingly.

7) Host permissions are broad (`http://*/*`, `https://*/*`)
- Might still be acceptable for this use-case, but requires strong justification and consistent store disclosure.
- Required fix:
  - Keep only if truly needed.
  - Add explicit justification in submission text and README.
  - Confirm no unnecessary capabilities are requested.

### Medium severity

8) Anchor restore is heuristic, not “exact spot”
- Restore frequently falls back to matching first 80 chars in tagged elements.
- Repeated text or DOM changes can mis-anchor threads.
- Required fix:
  - Improve anchor model (range serialization + robust fallback selectors).
  - Downgrade claim language if exact anchoring cannot be guaranteed.

9) SPA navigation handling incomplete
- Only `popstate` is handled; `pushState/replaceState` path changes are not fully managed.
- Required fix:
  - Add robust URL-change detection for SPA routes.
  - Reconcile thread lifecycle on client-side route changes.

10) “Reminders” are currently just saved items
- No scheduling (`chrome.alarms`), no notifications, no due time.
- Required fix:
  - Either implement real reminders or rename feature to avoid misleading behavior.

11) “Clear thread history” is partial
- Clearing threads removes `history`, but persisted `threads:<url>` keys remain.
- Required fix:
  - Add full clear mode that removes all thread blobs (`threads:*`) and history index.
  - Label actions clearly if split into “clear recent list” vs “delete all saved threads.”

12) Daily usage schema integrity risk
- No unique constraint on (`user_id`, `date`) for `DailyUsage`.
- Required fix:
  - Add DB uniqueness constraint and migration.
  - Keep atomic upsert/increment logic.

13) CORS is wide open (`allow_origins=["*"]`)
- Required fix:
  - Restrict allowed origins to expected callers where possible.
  - Reevaluate threat model for bearer token exposure.

### Low severity / consistency debt

14) `PRODUCTION.md` is stale and contradictory
- Mentions unbuilt Stripe + Firebase vars while code already uses Stripe and no Firebase in this flow.
- Required fix:
  - Rewrite `PRODUCTION.md` to match real architecture and env vars.

15) Popup and docs hardcode production URL
- Risky for env switching and release mistakes.
- Required fix:
  - Introduce a build-time config replacement step for `BACKEND_URL`.
  - Document environment-specific packaging steps.

16) Model fallback silently changes user choice
- Unknown model is silently coerced to `gpt-4.1-mini`.
- Required fix:
  - Return explicit validation error or surface normalized value clearly.

## README claim verification matrix

- Inline threads: **Implemented**
- Persists per URL: **Implemented (with caveats on route changes)**
- Multiple threads/page: **Implemented**
- Quick actions: **Implemented**
- Todos: **Implemented**
- Reminders: **Partially implemented (saved list only)**
- LaTeX via KaTeX: **Partially implemented / packaging issue**
- Works everywhere: **Overstated**
- Private by design: **Partially true but currently misworded**

## Main agent execution plan (ordered)

1. **Fix packaging blockers**
- Add missing `katex.min.js` and icon files.
- Validate extension loads without missing-resource errors.

2. **Fix security/compliance fundamentals**
- Remove JWT fallback secret behavior.
- Align retention code + policy and schedule purge.
- Add delete-account UX and Stripe deletion/cancel handling.

3. **Fix public claims and store-facing text**
- Update README, landing page, privacy page, popup copy for accurate data flow.
- Align Chrome Web Store data disclosures with implementation.

4. **Fix behavior mismatches**
- Improve anchor restoration reliability.
- Handle SPA route changes (`pushState`, `replaceState`, URL observer strategy).
- Resolve reminders semantics and clear-history completeness.

5. **Cleanup docs and release process**
- Rewrite `PRODUCTION.md`.
- Introduce env-specific config/build packaging checks.
- Add pre-submit checklist script for manifest asset existence + URL consistency.

## Suggested acceptance criteria before submit

- Extension loads from zipped package with zero missing file errors.
- Privacy policy text exactly matches runtime data flow and retention behavior.
- `JWT_SECRET` absence causes hard failure (no insecure runtime).
- In-popup account deletion exists and works end-to-end.
- Retention cleanup runs on schedule and matches stated policy.
- Thread restore accuracy validated on repeated text and SPA navigation scenarios.
- Chrome Web Store submission metadata (permissions, privacy, support, pricing) consistent with code.

