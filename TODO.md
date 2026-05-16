# Nabu — TODO

## 🚀 Before Chrome Web Store submission

- [ ] Set up new Railway service pointing to `nabu-extension` repo (backend root: `backend/`)
- [ ] Add PostgreSQL plugin to the new Railway service
- [ ] Set env vars on new Railway service:
  - `JWT_SECRET` — run `openssl rand -hex 32` in terminal
  - `OPENAI_API_KEY` — your OpenAI key
  - `BACKEND_URL` — new Railway URL (e.g. `https://nabu-xxxx.up.railway.app`)
  - `STRIPE_SECRET_KEY` — from Stripe dashboard
  - `STRIPE_WEBHOOK_SECRET` — from Stripe dashboard
  - `STRIPE_PRICE_ID` — from Stripe dashboard
- [ ] Update `BACKEND_URL` placeholder in `chrome-extension/popup.js` line 1 and `chrome-extension/content.js` line 167 with the new Railway URL
- [ ] Update privacy policy link in `chrome-extension/popup.html` to the new Railway URL
- [ ] Rebuild `backend/static/nabu.zip` after updating the URLs
- [ ] Pay $5 Chrome Web Store developer fee at chrome.google.com/webstore/devconsole
- [ ] Submit extension zip to Chrome Web Store with:
  - Privacy policy URL: `https://<new-railway-url>/privacy`
  - Host permission justification: "Nabu injects annotation threads on any webpage the user visits. The extension must run on all pages so users can annotate any content they read."

---

## 💳 Stripe setup

- [ ] Create Stripe account at stripe.com
- [ ] Create a product: "Nabu Pro"
- [ ] Create a recurring price: $0.99/month
- [ ] Copy the `STRIPE_PRICE_ID` (starts with `price_`) to Railway env vars
- [ ] Set up Stripe webhook pointing to `https://<railway-url>/api/extension/webhook`
  - Events to listen for: `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.paused`
- [ ] Copy `STRIPE_WEBHOOK_SECRET` from webhook dashboard to Railway env vars
- [ ] Wire "Upgrade" button in popup to `/api/extension/create-checkout`

---

## 🔒 Privacy & compliance

- [ ] Wire up `purge_old_data()` — call weekly on a schedule (Railway cron or background task in `main.py` lifespan)
- [ ] If targeting EU users: add cookie/consent banner to landing page
- [ ] If targeting EU users: sign Data Processing Agreements with OpenAI and Stripe

---

## 🛠 Technical debt

- [ ] `_rate_buckets` is in-memory — resets on server restart. Replace with Redis or DB-backed rate limiting for production scale
- [ ] Add a `DELETE /api/extension/account` call in the extension popup (settings panel) so users can self-serve data deletion
- [ ] Consider encrypting email at rest in the DB (currently plain text)
- [ ] Screenshots in Chrome Web Store must be exactly 1280×800 — verify current ones display well before submitting

---

## 📱 Future (post-launch)

- [ ] PDF support — intercept PDF navigations, render with PDF.js so extension works on PDFs
- [ ] Mobile web app — separate product for the AI Secretary feature
- [ ] Cloud sync — optionally sync threads across devices (requires auth)
- [ ] Scheduled morning briefings for the AI Secretary
