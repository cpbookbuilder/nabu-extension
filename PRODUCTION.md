# Production Checklist

Architecture: Chrome extension → FastAPI backend on Railway (PostgreSQL plugin) → OpenAI / Stripe.
Identity is a per-install device UUID (no Google OAuth, no Firebase).

---

## 1. Backend — Railway

1. Push the repo to GitHub.
2. railway.app → New Project → Deploy from repo, root `backend/`.
3. Add a PostgreSQL plugin from Railway templates.
4. Generate a service domain (port 8080).
5. Set the env vars in section 2.

---

## 2. Environment variables (backend)

| Variable | How to get it | Required |
|---|---|---|
| `DATABASE_URL` | Auto-provided by Railway PostgreSQL plugin | ✅ |
| `OPENAI_API_KEY` | platform.openai.com → API keys | ✅ |
| `JWT_SECRET` | `openssl rand -hex 32` | ✅ — backend refuses to start without it |
| `BACKEND_URL` | Public Railway URL (e.g. `https://nabu-extension-production.up.railway.app`) | ✅ |
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys (`sk_live_...`) | ✅ for billing |
| `STRIPE_PRICE_ID` | Stripe dashboard → Products → Pricing (`price_...`) | ✅ for billing |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → Webhooks → endpoint (`whsec_...`) | ✅ for billing |

---

## 3. Stripe

1. Create a product "Nabu Pro", recurring price $4.99/month → copy the `price_…` ID.
2. Webhook endpoint: `https://<your-backend>/api/extension/webhook`.
3. Subscribe to events: `checkout.session.completed`, `customer.subscription.resumed`,
   `customer.subscription.deleted`, `customer.subscription.paused`,
   `customer.subscription.updated`, `invoice.paid`, `invoice.payment_failed`.
4. Switch from test → live mode and re-copy `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

---

## 4. Extension build for the Chrome Web Store

1. Update `BACKEND_URL` to the Railway URL in:
   - `chrome-extension/popup.js` (line 1)
   - `chrome-extension/content.js` (search for `BACKEND_URL`)
2. Update the `https://nabu-extension-production.up.railway.app/privacy` link in
   `chrome-extension/popup.html` if your URL differs.
3. Re-zip: `cd chrome-extension && zip -r ../backend/static/nabu.zip . -x "*.DS_Store"`.
4. Upload the same zip to chrome.google.com/webstore/devconsole.

---

## 5. Chrome Web Store submission

1. Pay one-time $5 developer fee.
2. Create a new item, upload the zipped `chrome-extension/` directory.
3. Privacy policy URL: `https://<your-backend>/privacy`.
4. Justify host permissions (`https://*/*`, `http://*/*`):
   "Nabu lets users anchor AI threads to text on any webpage. The content script
    must run on every page the user wants to annotate."
5. Justify `tabs` permission: "Used only to open the user's history page from the popup."
6. Submit. Reviews typically take 1–3 business days.

---

## 6. Compliance

- **JWT_SECRET** is mandatory (backend raises on startup if absent).
- **Retention** is 30 days for free, unidentified users — see `purge_old_data()` in
  `extension_routes.py` and the `_purge_loop` in `main.py` (runs daily).
- **Right to erasure** is exposed via `DELETE /api/extension/account` and the
  "Delete my data" button in the popup. Stripe subscriptions are cancelled as
  part of deletion.
- **CORS** is restricted to `chrome-extension://*` and the production Railway origin.
- **Data flow**: extension → backend → OpenAI. Backend processes content in
  transit only; nothing is logged or persisted. Privacy page must always reflect
  this exact flow.
