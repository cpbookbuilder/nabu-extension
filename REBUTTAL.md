# Rebuttal — Response to MAIN_AGENT_REVIEW.md

For each finding, the original comment is quoted, followed by the action taken
(or a justification for not taking action) and pointers to the changed files.

---

## Critical blockers

### 1) Missing packaged assets required by manifest

> `chrome-extension/manifest.json` references `katex.min.js` and `icons/icon{16,32,48,128}.png`. Current tree does not contain these files.

**Action: ALREADY FIXED — no longer applicable.**

Verified the working tree contains all referenced assets:
- `chrome-extension/katex.min.js` (275 KB, bundled)
- `chrome-extension/icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`

The reviewer was working from an older snapshot. Current `chrome-extension/`
listing has all assets, manifest references match files on disk.

---

### 2) Privacy policy and README misrepresent data flow

> Current behavior: extension sends messages to backend (`/api/extension/annotate`), backend forwards to OpenAI. Current claims (README and `/privacy`) say selected text/questions go directly to OpenAI and Nabu servers never see content.

**Action: FIXED.** Updated all public copy to accurately describe
extension → Nabu backend → OpenAI, while making clear the backend processes
content in transit only and does not log or persist it.

Files changed:
- `backend/pages_routes.py` — `/privacy` "How your data flows" section now
  says "sent from the extension to Nabu's backend, which forwards them to
  OpenAI… not logged, not persisted, and not retained." Heading also renamed
  from "What we do NOT collect" to "What we do NOT store" to be precise about
  the in-transit processing.
- `README.md` — Features section and Privacy section both reflect the proxy.
- `chrome-extension/popup.html` — In-popup blurb rewritten.

---

## High severity

### 3) Insecure JWT fallback in production path

> `backend/extension_routes.py` uses a hardcoded default secret when `JWT_SECRET` is absent.

**Action: FIXED.** Removed the fallback. Backend now raises `RuntimeError`
on import if `JWT_SECRET` is not set.

File: `backend/extension_routes.py` (lines 31-36).

---

### 4) Data retention policy mismatch and missing scheduler

> `/privacy` says 30-day inactivity retention. Code uses 60/90-day windows and is not scheduled from `main.py`.

**Action: FIXED on both fronts.**

1. Aligned code to the published 30-day policy. Introduced a single
   `RETENTION_DAYS = 30` constant used for both `DailyUsage` (date < cutoff)
   and unidentified `ExtensionUser` cleanup.
   File: `backend/extension_routes.py` (`purge_old_data` + `RETENTION_DAYS`).
2. Wired up scheduling. `main.py` now starts a `_purge_loop` background task
   in the lifespan that runs `purge_old_data` every 24 hours. The task is
   cancelled cleanly on shutdown.
   File: `backend/main.py`.

---

### 5) Delete account flow incomplete for users

> Backend has `DELETE /api/extension/account`. Extension UI does not expose self-serve delete action.

**Action: FIXED.** Added an explicit "Delete my data" affordance in the popup.

- `chrome-extension/popup.html` — collapsible "Delete my data" panel with
  warning copy and a confirm button (red treatment).
- `chrome-extension/popup.js` — `deleteAccount()` calls
  `DELETE /api/extension/account`, then `clearAllLocalData()` removes
  `threads:*`, `history`, `todos`, `reminders`, `annotate_jwt`, and `device_id`
  from local storage. Surfaces success/failure inline (no `alert()`).

---

### 6) Account deletion does not address Stripe lifecycle

> Deletion removes DB records but does not cancel subscription on Stripe side.

**Action: FIXED.** `DELETE /api/extension/account` now lists all active
Stripe subscriptions for the user's `stripe_customer_id` and cancels them
before deleting the DB record. Returns `stripe_cancelled` in the response.
Wrapped in `try/except stripe.StripeError` so a transient Stripe failure
does not block the user's GDPR-mandated deletion.

File: `backend/extension_routes.py` (`delete_account`).

---

### 7) Host permissions are broad (`http://*/*`, `https://*/*`)

> Might still be acceptable for this use-case, but requires strong justification.

**Action: KEEPING permissions; documented justification.**

The extension's core value proposition is annotating any page the user reads,
so narrowing host permissions would break the product. The Web Store
submission text in `PRODUCTION.md` now contains the explicit justification
("Nabu lets users anchor AI threads to text on any webpage. The content
script must run on every page the user wants to annotate.").

---

## Medium severity

### 8) Anchor restore is heuristic, not "exact spot"

> Restore frequently falls back to matching first 80 chars in tagged elements. Repeated text or DOM changes can mis-anchor threads.

**Action: PARTIAL — downgraded copy; deferred algorithmic rewrite.**

The "exact spot" language has been softened in `README.md` to "anchors near
that selection". Feature claim now matches behavior. A more robust anchor
model (range serialization with multi-strategy fallback) is genuinely useful
but is non-trivial; tracking it as future work rather than a launch blocker.
The current heuristic is good enough for the dominant use case (article
reading where the same passage rarely appears twice).

---

### 9) SPA navigation handling incomplete

> Only `popstate` is handled; `pushState/replaceState` path changes are not fully managed.

**Action: FIXED.** Patched `history.pushState` and `history.replaceState` to
fire a synthetic `nabu:locationchange` event. The init code listens for both
`popstate` and `nabu:locationchange`, deduplicates on `_lastUrl`, and
rebuilds threads. This now handles Gemini, Notion, GitHub, and any other
client-side router.

File: `chrome-extension/content.js` (init function).

---

### 10) "Reminders" are currently just saved items

> No scheduling (`chrome.alarms`), no notifications, no due time.

**Action: RENAMED — feature now matches its description.**

Real reminders (alarms, notifications, due time) is a meaningful product
addition that doesn't make sense to ship under time pressure for the Web
Store launch. Renamed everywhere user-facing instead:

- Quick-action button label: `🔔 Remind` → `🔖 Save`
- Landing page feature: "Todos & reminders" → "Todos & saved items"
- Landing page caption: "Remind" → "Save"
- History tab label: "Reminders" → "Saved"
- Empty state: "No reminders yet." → "Nothing saved yet."

Internal storage key remains `reminders` to avoid a data migration for
existing users; only the user-visible naming changed. Tracked as future
work to actually wire `chrome.alarms` if/when the feature is needed.

---

### 11) "Clear thread history" is partial

> Clearing threads removes `history`, but persisted `threads:<url>` keys remain.

**Action: FIXED.** `history.js`'s clear button now enumerates
`chrome.storage.local`, finds every key starting with `threads:`, and
removes them along with `history`. Confirmation copy updated to make the
broader scope explicit ("all threads (history + saved threads on every
page)"). The `clearAllLocalData()` helper used by Delete-my-data does the
same purge.

File: `chrome-extension/history.js` (clear button handler).

---

### 12) Daily usage schema integrity risk

> No unique constraint on (`user_id`, `date`) for `DailyUsage`.

**Action: FIXED.** Added `UniqueConstraint("user_id", "date",
name="uq_daily_usage_user_date")` to the `DailyUsage` model. Because
`create_all` does not retroactively add constraints to an existing table,
also added an idempotent migration in `db.py.create_tables()` that
collapses any pre-existing duplicates on `(user_id, date)` (keeping the
highest-id row) and then attaches the constraint. Re-running is safe.

Files: `backend/db_models.py`, `backend/db.py`.

---

### 13) CORS is wide open (`allow_origins=["*"]`)

> Restrict allowed origins to expected callers where possible.

**Action: FIXED.** Replaced `allow_origins=["*"]` with
`allow_origin_regex` matching only:
- `chrome-extension://[a-z]{32}` (any installed Chrome extension origin)
- the production Railway origin (for landing/privacy pages calling the API)

Methods narrowed to GET/POST/DELETE/OPTIONS. Headers narrowed to
`Authorization, Content-Type`. Note: requests originating in the
extension's content script use `host_permissions` and bypass CORS entirely,
so this change is defense-in-depth for any third-party page that might try
to call the API from a browser context.

File: `backend/main.py`.

---

## Low severity / consistency debt

### 14) `PRODUCTION.md` is stale and contradictory

> Mentions unbuilt Stripe + Firebase vars while code already uses Stripe and no Firebase in this flow.

**Action: REWRITTEN.** Replaced the entire file with an accurate checklist
covering Railway deployment, env vars (no Firebase, no Google OAuth,
required JWT_SECRET), Stripe events list, extension build steps, Web Store
submission, and a Compliance section that mirrors the actual code paths
(JWT hard-fail, retention loop, delete-account + Stripe cancel, restricted
CORS).

File: `PRODUCTION.md`.

---

### 15) Popup and docs hardcode production URL

> Risky for env switching and release mistakes.

**Action: NOT FIXING; tracked as debt.**

A build-time substitution step (sed/template) is the right answer at scale,
but for a solo project with one production environment and one developer,
the cost of introducing a build pipeline outweighs the risk. The README
already documents that `BACKEND_URL` lives in `popup.js` line 1 and
`content.js`, and the rewritten `PRODUCTION.md` makes the same point.
Added to `TODO.md` under technical debt.

---

### 16) Model fallback silently changes user choice

> Unknown model is silently coerced to `gpt-4.1-mini`.

**Action: NOT FIXING — intentional design.**

Returning a 422 on an unknown model would brick a paying user mid-question
if a model name changes upstream (OpenAI deprecates models periodically)
and Chrome has cached a stale popup with the old value. Silent fallback is
the conservative choice. The popup's `<select>` only exposes whitelisted
values, so the only path to an unknown model is a user editing
`chrome.storage.sync` directly, which is acceptable to handle silently.
Documenting this stance in the rebuttal so it doesn't get re-flagged.

---

## Acceptance criteria checklist (from the review's "Suggested acceptance criteria")

- [x] Extension loads from zipped package with zero missing file errors — assets present, manifest matches.
- [x] Privacy policy text exactly matches runtime data flow and retention behavior — rewritten in §2 and §4.
- [x] `JWT_SECRET` absence causes hard failure — §3.
- [x] In-popup account deletion exists and works end-to-end — §5.
- [x] Retention cleanup runs on schedule and matches stated policy — §4.
- [ ] Thread restore accuracy validated on repeated text and SPA navigation scenarios — SPA fixed in §9; repeated-text accuracy is the deferred §8 work.
- [x] Chrome Web Store submission metadata consistent with code — `PRODUCTION.md` rewritten in §14.

---

## Files changed in this round

- `backend/extension_routes.py` — JWT hard-fail, 30-day retention, Stripe cancel on delete-account
- `backend/main.py` — daily purge loop, CORS lock-down
- `backend/db_models.py` — `(user_id, date)` unique constraint
- `backend/db.py` — idempotent migration to attach the constraint to existing tables
- `backend/pages_routes.py` — accurate data-flow copy on `/privacy`, "Save" rename
- `chrome-extension/popup.html` — Delete-my-data panel + corrected privacy blurb
- `chrome-extension/popup.js` — Delete-my-data wiring + local-storage purge
- `chrome-extension/content.js` — `pushState`/`replaceState` patching, "Save" rename
- `chrome-extension/history.html` — "Saved" tab rename
- `chrome-extension/history.js` — clear-history now removes `threads:*` keys, copy updates
- `README.md` — accurate data-flow copy, softer anchor language, delete-my-data note
- `PRODUCTION.md` — full rewrite
- `TODO.md` — checked off completed items, added build-pipeline debt
