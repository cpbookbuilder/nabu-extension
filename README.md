# Nabu — AI threads for anything you read

> Named after the Babylonian god of writing and wisdom.

Nabu is a Chrome extension that lets you anchor AI conversation threads to any text on any webpage. Select text, ask a question, get an answer — right there, inline, without losing your place. Threads persist per URL and come back when you revisit the page.

---

## Features

- **Inline threads** — select any text and a thread card anchors near that selection
- **Persists per URL** — come back to the same page, your threads are still there
- **Multiple threads per page** — annotate as many passages as you want simultaneously
- **Quick actions** — "What does this mean?" and "Explain more" fire with one click
- **Todos & saved-for-later** — save any selection directly from the popover
- **LaTeX rendering** — equations render correctly via KaTeX
- **Works on most pages** — articles, research papers, docs, LLM outputs (some sites with strict CSPs may not work)
- **Private by design** — conversation content is proxied through our backend to OpenAI but is never logged or persisted

---

## Repo structure

```
nabu-extension/
├── chrome-extension/      # The Chrome extension
│   ├── manifest.json
│   ├── content.js         # Core — floating button, thread cards, markdown/LaTeX rendering
│   ├── content.css
│   ├── background.js      # Service worker — device ID generation
│   ├── popup.html/js      # Extension popup — usage, upgrade, restore
│   ├── history.html/js    # Full thread history page
│   ├── katex.min.js       # Bundled KaTeX (equation rendering)
│   └── icons/             # Extension icons (16/32/48/128px)
├── backend/               # FastAPI backend
│   ├── main.py
│   ├── extension_routes.py  # Auth, usage tracking, annotate proxy, Stripe
│   ├── pages_routes.py      # Landing page + privacy policy
│   ├── db.py / db_models.py
│   ├── requirements.txt
│   └── static/
│       ├── nabu.zip           # Extension download
│       ├── icon128.png
│       └── screenshots/       # Landing page screenshots
├── TODO.md                # Pending tasks before launch
├── PRODUCTION.md          # Full deployment checklist
└── README.md
```

---

## How it works

```
User selects text → floating button appears → thread card opens
    → question sent to backend → backend calls OpenAI → streams response back
    → thread persists in chrome.storage.local per URL
```

**Freemium model:**
- Free: 5 questions/day per device (no sign-in required)
- Pro: $4.99/month via Stripe — unlimited questions

Device identity is a randomly generated UUID stored locally — no account, no sign-in. Stripe email is used only for subscription recovery.

---

## Local development

### Extension

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `chrome-extension/` folder

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Create a .env file:
echo "DATABASE_URL=postgresql+asyncpg://..." > .env
echo "OPENAI_API_KEY=sk-..." >> .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "BACKEND_URL=http://localhost:8000" >> .env

uvicorn main:app --reload
```

Update `chrome-extension/popup.js` line 1 and `chrome-extension/content.js` to point `BACKEND_URL` at `http://localhost:8000` for local testing.

---

## Deployment

See **[PRODUCTION.md](./PRODUCTION.md)** for the full deployment checklist and **[TODO.md](./TODO.md)** for pending items before Chrome Web Store submission.

**Quick summary:**
1. Deploy `backend/` to Railway with a PostgreSQL plugin
2. Set env vars: `JWT_SECRET`, `OPENAI_API_KEY`, `BACKEND_URL`, Stripe vars
3. Update `BACKEND_URL` in the extension files → rebuild the zip
4. Submit to Chrome Web Store (see PRODUCTION.md)

---

## Privacy

- Selected text and questions are sent from the extension to Nabu's backend, which proxies them to OpenAI and streams the response back. The backend processes them in transit only — nothing is logged or written to the database.
- Only persisted server-side: device UUID, daily question count, email (Pro subscribers only)
- Right to erasure: in-popup "Delete my data" button or `DELETE /api/extension/account`. The backend also cancels any active Stripe subscription on delete.
- Full policy: `/privacy` on the backend URL

---

## Contact

**nabu.extension@gmail.com**
