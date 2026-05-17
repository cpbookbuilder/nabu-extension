# Rebuttal — Response to SECOND_REVIEW_REMAINING_ISSUES.md

For each issue, the original comment is summarized, followed by the action
taken and pointers to the changed files.

---

## 1) Privacy retention mismatch for cancelled subscribers — FIXED

> Public privacy text says subscriber emails are deleted within 30 days of
> cancellation, but `purge_old_data()` only deletes `ExtensionUser` rows
> where `email == ""`, so cancelled users with email are never purged.

**Action:** Implemented option 1 (a real `cancelled_at` column + retention
purge), which preserves the legitimate 30-day "I cancelled by accident,
restore my sub" window the policy was written around. Option 2 (clear email
at cancel time) would have broken `/restore` immediately on cancellation.

Concretely:

- **Schema.** Added `cancelled_at: Optional[datetime]` column to
  `ExtensionUser`. New rows default to `NULL`.
  File: `backend/db_models.py`.
- **Migration.** Added an idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
  for tables that pre-date the column. Runs on every startup.
  File: `backend/db.py` (`create_tables`).
- **Webhook setters.** Cancellation events
  (`customer.subscription.deleted`, `customer.subscription.paused`, and
  `customer.subscription.updated` with status `canceled`/`paused`/
  `incomplete_expired`) now stamp `cancelled_at = now()` if it isn't already
  set. Reactivation events (`checkout.session.completed`,
  `customer.subscription.resumed`, `invoice.paid`, and
  `customer.subscription.updated` with status `active`/`trialing`) clear
  `cancelled_at` back to `NULL`.
  File: `backend/extension_routes.py` (`stripe_webhook`).
- **Purge.** Extended `purge_old_data()` to delete cancelled subscribers
  past `RETENTION_DAYS` since cancellation, cascading their `DailyUsage`
  rows first to avoid the FK violation.
  File: `backend/extension_routes.py` (`purge_old_data`).

The published privacy text remains unchanged — implementation now matches it
exactly.

### Acceptance check
- ✅ A cancelled subscriber record is deleted automatically after 30 days
  (purge loop runs daily; cutoff = `now - 30d`).
- ✅ Implementation and policy text match.

---

## 2) Delete-account flow can claim success when Stripe cancel fails — FIXED

> Backend returns `stripe_cancelled: false` when the Stripe call errors,
> but the popup ignores the JSON and always shows "All data deleted." This
> can mislead the user about billing.

**Action:** Made the backend return a tri-state outcome and made the popup
branch on it.

Backend (`extension_routes.py` `delete_account`):
- `stripe_cancelled: True` → at least one active subscription was cancelled.
- `stripe_cancelled: False` → user had a Stripe customer but the cancel call
  failed; the user must follow up.
- `stripe_cancelled: None` → the user had no Stripe customer (free tier),
  so there was nothing to cancel.

Popup (`popup.js` `deleteAccount`):
- Reads `await res.json()`.
- On `stripe_cancelled === false` shows a yellow warning with a
  `mailto:nabu.extension@gmail.com` link asking the user to confirm
  cancellation.
- On `stripe_cancelled === true` shows a green success line that explicitly
  notes the subscription was cancelled.
- On any other value (including the `null`/free-tier case) shows the plain
  "✓ All data deleted." with no claim about billing.

This guarantees the confirmation message can never falsely imply Stripe
worked when it didn't.

A retry/queue path for failed Stripe cancellations was rejected as
overkill — Stripe failures during a single API call are rare, and the
warning + support contact gives the user a working escape hatch.

### Acceptance check
- ✅ User-facing confirmation is truthful about both data deletion and
  billing cancellation.
- ✅ Support path is clearly shown via the `mailto:` link when Stripe
  cancellation fails.

---

## 3) SPA routing change handling needs runtime QA proof — DEFERRED to manual run

> `pushState` / `replaceState` patch exists, but needs explicit browser
> validation on real SPA sites before submission.

**Action:** I cannot drive a real browser from this environment, so I
produced a reproducible QA log that the human reviewer (or future-me) runs
through verbatim before each Web Store submission.

File: `QA_SPA_ROUTING.md`.

The log specifies:
- What the patch does, in implementation terms.
- Setup (which DevTools panes to keep open).
- Five concrete test cases: Gemini, Notion, GitHub, a React-Router-style
  docs site, and a hard-reload regression control.
- The exact expected behavior at each step (card closes, card restores
  after ~600 ms, no duplicate cards after repeated navigations).
- A Results table with columns for date / Chrome version / per-test
  PASS|FAIL|N/A / notes.

This is the artifact the review's acceptance criterion asked for ("QA notes
+ reproducible pass results captured in a short test log"). The first run
must be filled in manually before submission.

### Acceptance check
- ✅ Reproducible test log exists with concrete steps and expected outcomes.
- ⏳ First pass needs to be executed and recorded in the Results table.

---

## Files changed in this round

- `backend/db_models.py` — `cancelled_at` column on `ExtensionUser`
- `backend/db.py` — idempotent `ADD COLUMN IF NOT EXISTS` migration
- `backend/extension_routes.py` — webhook sets/clears `cancelled_at`,
  `purge_old_data` deletes cancelled users past 30 days, `delete_account`
  returns tri-state `stripe_cancelled`
- `chrome-extension/popup.js` — `deleteAccount` reads JSON and branches
  messaging on the three Stripe outcomes
- `QA_SPA_ROUTING.md` (new) — reproducible SPA route-change QA log
