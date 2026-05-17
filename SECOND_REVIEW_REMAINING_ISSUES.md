# Second Review — Remaining Issues to Fix

This file lists only the issues still open after the rebuttal changes.

## 1) Privacy retention mismatch for canceled subscribers (High)

### Problem
Public privacy text says subscriber emails are deleted within 30 days of cancellation, but backend logic does not currently implement that behavior.

### Evidence
- `backend/pages_routes.py` says:
  - "Email addresses for Pro subscribers are retained for the duration of the subscription and deleted within 30 days of cancellation."
- `backend/extension_routes.py` on subscription cancellation only sets `user.subscribed = False` and keeps `email` populated.
- `purge_old_data()` only deletes `ExtensionUser` rows where `email == ""`, so canceled users with email are never purged by that path.

### Required fix
- Implement a real "canceled-at" retention path for email/subscriber records.
- Options:
  1. Add `cancelled_at` column and purge canceled users/emails older than 30 days.
  2. Or clear email at cancel time and ensure subscription restore/account logic still works as intended.
- Update privacy text only if behavior changes materially.

### Acceptance check
- A canceled subscriber record is deleted/anonymized automatically after 30 days.
- Implementation and policy text match exactly.

---

## 2) Delete-account flow can claim success when Stripe cancel fails (High)

### Problem
`DELETE /api/extension/account` may return success while Stripe cancellation failed (`stripe_cancelled = false`), and popup always shows "All data deleted." This can mislead users about billing state.

### Evidence
- `backend/extension_routes.py` catches `stripe.StripeError`, continues deletion, returns `stripe_cancelled: false`.
- `chrome-extension/popup.js` does not read response JSON for `stripe_cancelled`; it always shows success text on HTTP 200.

### Required fix
- Surface Stripe cancellation outcome to user.
- Minimum:
  - Read JSON response in popup and branch messaging:
    - if `stripe_cancelled === true`: success message.
    - if `stripe_cancelled === false`: success for data deletion + warning that subscription cancellation may need support/manual follow-up.
- Optional stronger fix:
  - Add retry/queue/reconciliation path for Stripe cancellation failures.

### Acceptance check
- User-facing delete confirmation is truthful about both data deletion and billing cancellation state.
- Support path is clearly shown when Stripe cancellation fails.

---

## 3) SPA routing change handling needs runtime QA proof (Medium)

### Problem
`pushState` / `replaceState` patch exists, but this still needs explicit browser validation on real SPA sites before store submission.

### Evidence
- `chrome-extension/content.js` now monkey-patches history methods and dispatches `nabu:locationchange`.
- Static review cannot confirm this covers all target apps reliably.

### Required fix
- Run manual QA on at least:
  - Gemini (or similar chat SPA)
  - Notion
  - GitHub
  - One docs site with client-side routing
- Validate:
  - Existing thread cards clear on route change.
  - Threads for new URL restore correctly.
  - No duplicate listeners/cards after many navigations.

### Acceptance check
- QA notes + reproducible pass results captured in a short test log.

---

## Suggested execution order

1. Fix retention-policy implementation mismatch.
2. Fix delete-account Stripe outcome messaging.
3. Run SPA route-change QA and document outcomes.

