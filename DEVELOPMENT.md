# Nabu — Development guide

How to make changes to Nabu without breaking production, from local setup
through Chrome Web Store release.

---

## 1. One-time setup

### Backend

```bash
cd backend
# Python 3.10+ (Railway uses 3.13; CI uses 3.13; 3.10 is the floor)
python3 -m venv .venv-test
.venv-test/bin/pip install -r requirements-dev.txt
```

Required env vars in `backend/.env`:

```ini
DATABASE_URL=postgresql+asyncpg://...        # local Postgres, or `sqlite+aiosqlite:///./dev.db` for quick hacks
JWT_SECRET=$(openssl rand -hex 32)
OPENAI_API_KEY=sk-...
# Optional (billing):
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
BACKEND_URL=http://localhost:8000
# Optional (admin dashboard):
ADMIN_PASSWORD=...
```

Run locally:

```bash
.venv-test/bin/uvicorn main:app --reload
```

### Extension

1. `chrome://extensions` → **Developer mode** ON
2. **Load unpacked** → `chrome-extension/`
3. To point at your local backend, edit the `BACKEND_URL` constant at the top of
   `content.js`, `popup.js`, and `dashboard.js`. **Revert before opening a PR.**

---

## 2. Branch + PR flow

`main` is protected. You cannot push to it directly. Every change goes through
a PR with passing CI.

```bash
git checkout -b ess/short-description-of-change
# ...edit, commit small focused commits...
git push -u origin ess/short-description-of-change
gh pr create --fill   # or open the PR in the GitHub UI
```

A PR can merge when:

- Backend CI is green (ruff + pytest)
- Frontend CI is green (manifest + content-script syntax)
- You self-review the diff in the GitHub UI ("did I leave any `BACKEND_URL=localhost` in?")

Solo dev exception: branch protection allows admin bypass for genuine hotfixes.
Use it sparingly — every bypass is logged in the repo audit trail.

### Commit style

Mirror existing commits (`git log --oneline -20` is the source of truth):

```
<type>(<area>): short imperative summary

Optional body paragraph explaining *why* — the code already shows what.
```

Common `<type>` values used in this repo: `feat`, `fix`, `chore`, `test`, `perf`, `refactor`.
Common `<area>` values: `extension`, `backend`, `popover`, `dashboard`, `admin`, `usage`, `prod`.

---

## 3. Running tests & lint locally

```bash
cd backend
.venv-test/bin/pytest          # 13 tests, ~0.3s
.venv-test/bin/ruff check .    # lint
.venv-test/bin/ruff check --fix .  # auto-fix safe issues
```

Tests use an in-memory aiosqlite DB and a mocked OpenAI stream — no network, no
real API key needed. Add a test for every bug you fix; a regression that
shipped without one will catch a comment in review.

If you touch the extension content script, manually exercise:

- Selection → popover → ask question → answer streams
- Refresh page → restored threads reappear
- Open dashboard → counts update without refresh
- Try on a Google Docs editor URL → toast appears, no broken UI

---

## 4. Backend deploys

Railway watches `main`. Every merge to `main` triggers a redeploy of the
backend service. CI runs *before* merge (not before deploy), so a green main
== a known-good deploy.

### Required Railway dashboard settings

One-time setup to align Railway with this repo's new flow:

1. **Settings → Source → Branch** = `main`.
   No change needed if it's already this — that's the only branch we deploy.
2. **Settings → Healthcheck → Healthcheck Path** = `/healthz`.
   Without this, Railway marks a crashed deploy as "live" and serves 502s.
   With it, a failing boot is rolled back automatically.
3. **Settings → Healthcheck → Healthcheck Timeout** = `30s` (default is fine
   for most cases; bump if Postgres cold-start is slow).
4. **Variables tab** — confirm these are set (boot will fail-fast if any of
   the first three is missing):
   - `DATABASE_URL` (Railway reference, e.g. `${{Postgres.DATABASE_URL}}`)
   - `JWT_SECRET`
   - `OPENAI_API_KEY`
   - Optional: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`,
     `BACKEND_URL`, `ADMIN_PASSWORD`, `LOG_LEVEL` (default `INFO`)
5. **(Optional) Settings → Deploy Triggers → Wait for CI Status** = enabled.
   Tells Railway to wait for the GitHub `test` + `check` workflows to pass
   *after* the merge commit, then deploy. Belt-and-suspenders since branch
   protection already enforces CI before merge.

### No staging today

Single Railway service, single environment. If you later need a staging:

- Easiest: enable Railway's **PR Environments** — every PR gets its own
  ephemeral service with a unique URL. Pair with a separate Postgres
  branch/copy. Costs scale with concurrent PRs.
- Or create a second service `nabu-staging` pointed at a `staging` git
  branch, with separate env vars.

For now, treat `main` as production — that's what branch protection + CI
exists to defend.

If a deploy fails mid-stream:

- App boot retries DB connection 5× with exponential backoff (1/2/4/8/16s)
  before giving up — short Postgres hiccups self-heal.
- `GET /healthz` returns 503 when DB is unreachable; check it before assuming
  the whole router is dead.
- Look at `X-Request-ID` in failing client responses → grep Railway logs for
  the same ID to pull the full error trace.

### Migrations

Schema changes go in `db.py::create_tables` as an idempotent `ALTER TABLE
... ADD COLUMN IF NOT EXISTS ...` or `DO $$ ... END $$;` block. They run on
boot. SQLAlchemy `create_all` handles brand-new tables; the explicit DDL is
for evolving existing ones in-place.

This is intentionally lightweight — Alembic is overkill for a single-table
schema. Revisit if the model grows past 5 tables or if a rollback ever needs
to be reversible.

---

## 5. Extension releases (Chrome Web Store)

The CWS publishing API requires per-org service credentials we don't have set
up. So releases are tag-driven: CI builds a zip; you upload it manually.

### Step-by-step

1. **Bump the version** in `chrome-extension/manifest.json` (semver:
   `MAJOR.MINOR.PATCH`).
2. **Update `CHANGELOG.md`** with the user-visible changes.
3. **Open a PR**, get CI green, merge.
4. **Tag and push**:
   ```bash
   git checkout main && git pull
   git tag extension-v1.2.0
   git push origin extension-v1.2.0
   ```
5. **GitHub Actions** (`.github/workflows/release.yml`) builds the zip and
   creates a GitHub Release with `nabu-extension-v1.2.0.zip` attached.
6. **Upload to CWS**: open the [Chrome Web Store developer
   dashboard](https://chrome.google.com/webstore/devconsole), choose the
   extension, upload the zip, fill in the change notes (paste the
   `CHANGELOG.md` section), submit for review.
7. Once approved, **also update `backend/static/nabu.zip`** in the next PR so
   the landing page download stays in sync.

### Tag naming

- `extension-vX.Y.Z` → triggers extension release workflow.
- `backend-vX.Y.Z` is **not** used — backend deploys continuously from `main`.
- Plain `vX.Y.Z` tags are reserved; don't use them for now.

---

## 6. Adding a new dependency

- Backend: add to `requirements.txt` with an exact `==` pin, run
  `pip install -r requirements.txt`, commit. Bump the same way (deliberately,
  with tests).
- Backend dev: add to `requirements-dev.txt` only — keeps the Railway image
  small.
- Extension: vendor it into `chrome-extension/` (e.g., `katex.min.js`). No
  bundler is used; the manifest lists files directly.

---

## 7. Secrets

Never commit:

- `.env` (already in `.gitignore`)
- Real `OPENAI_API_KEY`, `STRIPE_*`, `JWT_SECRET`, `ADMIN_PASSWORD`
- Per-user data (device UUIDs from real users, real Stripe customer IDs)

Set production secrets in the Railway Variables tab. The list of required env
vars is enforced at boot (`main.py` raises if any of `DATABASE_URL`,
`JWT_SECRET`, `OPENAI_API_KEY` is missing).

---

## 8. Incident playbook

| Symptom | First check | Likely fix |
|---|---|---|
| Extension shows "no response" | `curl https://nabu-extension-production.up.railway.app/healthz` | 503 → restart Postgres in Railway. 502 → app crashed, check Railway logs. |
| Admin dashboard counts look wrong | Was the user pro? | Look at `extension_daily_usage` — every question (free or pro) now increments since `6057559`. |
| "Extension context invalidated" warning | Just reloaded the extension? | Refresh the open tab. The old content script lost its bridge to the extension. |
| Daily counter ticked but no answer | `X-Request-ID` → Railway logs | Check the `openai stream failed` log line. The reserve-and-refund path should have refunded. |

---

## 9. What to do on call-out / unfamiliar bug

1. Reproduce locally first.
2. Add a failing test that captures the bug.
3. Fix until the test passes.
4. PR title says "fix" (not "investigate" or "wip"); body explains the user-visible symptom and root cause.
5. CI green → merge → Railway deploys → verify in prod.
