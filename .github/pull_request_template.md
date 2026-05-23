## What changed

<!-- One sentence on the user-visible behaviour change or fix. -->

## Why

<!-- The bug, the missing feature, the user request, the analytics gap. Skip if obvious from the title. -->

## How

<!-- Brief — the diff is the source of truth. Call out anything non-obvious:
     migrations, env var changes, breaking API shape, perf considerations. -->

## Test plan

- [ ] `cd backend && .venv-test/bin/pytest` green
- [ ] `cd backend && .venv-test/bin/ruff check .` green
- [ ] If touching content script: manually verified selection → popover → ask
- [ ] If touching dashboard: stats tiles still update live
- [ ] If touching `/annotate`: refund still works on simulated OpenAI failure
- [ ] No `BACKEND_URL=localhost` left in `chrome-extension/*.js`

## Risk

<!-- Low / Medium / High. If Medium or High, name the rollback plan. -->

## Related

<!-- Linked issue, prior PR, Slack thread, etc. -->
