# Production Checklist

## 1. Google OAuth Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or use existing)
3. APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
4. Application type: **Chrome Extension**
5. In Developer Mode (`chrome://extensions`), find the extension's ID (e.g. `abcdefghijklmnop`)
6. Paste that ID into the "Application ID" field in Google Cloud Console
7. Copy the generated `client_id` (looks like `123456789.apps.googleusercontent.com`)
8. Paste it into `chrome-extension/manifest.json`:
   ```json
   "oauth2": {
     "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
     ...
   }
   ```

> Note: The extension ID changes if you reload it as unpacked. The production ID is permanent once published to the Chrome Web Store. Set up OAuth with the production ID after publishing.

---

## 2. Backend Deployment (Railway)

1. Push backend to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Add a PostgreSQL plugin (Railway provides one)
4. Set environment variables (see section 3)
5. Copy the deployment URL (e.g. `https://annotate-ai.up.railway.app`)
6. Replace `https://YOUR_BACKEND_URL` in:
   - `chrome-extension/popup.js` line 1
   - `chrome-extension/content.js` line 4

---

## 3. Environment Variables (backend)

Set these in Railway (or wherever the backend is deployed):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Provided by Railway PostgreSQL plugin |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `JWT_SECRET` | Any long random string (e.g. `openssl rand -hex 32`) |
| `FIREBASE_PROJECT_ID` | From Firebase console (for web frontend auth) |
| `FIREBASE_PRIVATE_KEY` | From Firebase service account JSON |
| `FIREBASE_CLIENT_EMAIL` | From Firebase service account JSON |

---

## 4. Stripe Subscription (not yet built)

Still needs to be implemented:

- [ ] Create Stripe account, get API keys
- [ ] Add `stripe` to `backend/requirements.txt`
- [ ] Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` env vars
- [ ] Create a Stripe product + price (e.g. $9/mo)
- [ ] Add `POST /api/extension/create-checkout` endpoint → returns Stripe checkout URL
- [ ] Add `POST /api/extension/webhook` endpoint → on `customer.subscription.created/deleted`, set `ExtensionUser.subscribed = True/False`
- [ ] Wire the "Upgrade" button in `popup.js` to open the checkout URL
- [ ] Add `STRIPE_PUBLISHABLE_KEY` to the popup for the upgrade flow

---

## 5. Chrome Web Store Publishing

1. Create a 128×128 PNG icon, add to `chrome-extension/icons/`
2. Update `manifest.json` to reference it:
   ```json
   "icons": { "128": "icons/icon128.png" }
   ```
3. Take 3–5 screenshots at 1280×800
4. Write a short description (max 132 chars) and long description
5. Go to [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
6. Pay one-time $5 developer fee
7. Create new item → upload a zip of the `chrome-extension/` folder
8. Fill in store listing, screenshots, privacy policy URL
9. Justify the `https://*/*` host permission: *"The extension annotates web content on any page the user visits"*
10. Submit for review (takes 1–3 business days)

> After publishing, the extension gets a permanent ID. Update the Google OAuth client with this ID and redeploy.

---

## 6. Privacy Policy

Required by Google for any extension that handles user data. Needs to cover:
- Google account info (email) is used only for authentication
- Usage counts are stored server-side to enforce the free tier limit
- Selected text is sent to OpenAI to generate responses
- No data is sold or shared with third parties

Host it on GitHub Pages, Notion, or any public URL.
