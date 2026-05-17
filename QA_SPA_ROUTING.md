# SPA route-change QA log

Manual smoke test for the `pushState` / `replaceState` patch in
`chrome-extension/content.js`. Run before every Chrome Web Store submission
and paste the date + result in the Results table at the bottom.

## What the patch does

`content.js` monkey-patches `history.pushState` and `history.replaceState` to
fire a `nabu:locationchange` event. The init code listens for `popstate` and
`nabu:locationchange`, deduplicates on `_lastUrl`, then closes all open
threads, drops `_pendingRecords`, and calls `restoreThreads()` after a 600 ms
debounce. The expected effect on every client-side navigation:

1. Existing thread cards are closed.
2. After the new route renders, threads stored under the new URL key restore.
3. Repeated navigations do not accumulate listeners or duplicate cards.

## Setup

1. Load the unpacked extension from `chrome-extension/` in
   `chrome://extensions` (Developer mode on).
2. Open DevTools → Application → Storage → Local Storage to watch
   `threads:<url>` entries appear.
3. Keep the Console open — `nabu:locationchange` and any errors will show
   up there.

## Test matrix

For each site below, perform the steps and tick the result.

### A. Gemini (gemini.google.com) — chat SPA

1. Open a Gemini conversation.
2. Select a sentence in any model response → click the floating Ask button →
   type a question → wait for the AI reply.
3. In the Gemini sidebar, click **+ New chat** (this `pushState`s to a new URL).
   - Expected: thread card closes, no JS error, URL bar updates.
4. Click your previous chat in the Gemini sidebar to navigate back.
   - Expected: thread card restores under the original anchor after ~600 ms.
5. Repeat the new-chat → back-to-old-chat cycle 3 times.
   - Expected: no duplicate cards, no orphan highlights.

### B. Notion (notion.so) — page-as-route

1. Open any Notion page.
2. Select a paragraph → start a thread → ask a question.
3. Click into a different sub-page (left sidebar). URL changes via `pushState`.
   - Expected: card closes.
4. Browser back.
   - Expected: card restores.

### C. GitHub (github.com) — partial SPA navigation

1. Open a repo's file tree.
2. On a file's blob view, select a few lines of code → start a thread.
3. Click another file in the tree (PJAX-style nav).
   - Expected: card closes.
4. Browser back.
   - Expected: card restores under the same lines.

### D. A docs site with client-side routing (Stripe Docs or React Router docs)

1. Open https://docs.stripe.com or any React Router site.
2. Select text on one doc page → start a thread → ask.
3. Click a sidebar link to a different doc page.
   - Expected: card closes.
4. Browser back.
   - Expected: card restores.

### E. Regression — full page load (control)

1. Visit a static article (e.g. an MDN page).
2. Start a thread, ask a question.
3. Hard reload the page (Cmd+Shift+R).
   - Expected: thread card restores. (This validates the popstate-free path.)

## What to capture

- Date + Chrome version.
- For each test: PASS / FAIL / N/A.
- For any FAIL: a one-line note (URL, what happened, console error if any).

## Results

| Date | Chrome | A. Gemini | B. Notion | C. GitHub | D. Docs SPA | E. Reload | Notes |
|------|--------|-----------|-----------|-----------|-------------|-----------|-------|
|      |        |           |           |           |             |           |       |
