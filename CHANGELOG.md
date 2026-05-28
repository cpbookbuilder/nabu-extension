# Changelog

User-visible changes per extension release. Format:

```
## [vX.Y.Z] — YYYY-MM-DD
### Added
### Changed
### Fixed
```

Backend-only changes don't need an entry (they deploy continuously).

---

## [Unreleased]

(nothing yet)

---

## [v1.2.5] — 2026-05-28

### Added
- Adding a selection to Todos or Saved now shows a card matching the question-thread style: the highlighted text in the header and a status label ("✓ Added to Todos" / "🔖 Saved for later") in the body. Clicking × removes the card, the highlight, and the saved item.

### Changed
- KaTeX CSS and fonts are now bundled in the extension — no third-party CDN requests at runtime. The extension makes requests only to its own backend.
- Dropped the `http://*/*` host permission (HTTPS-only) to narrow the extension's access footprint.
- Checkout links now open via the background worker instead of `window.open`.

### Fixed
- Math/equations now render automatically — the model is instructed to format mathematical notation as LaTeX without being asked.

---

## [v1.2.4] — 2026-05-27

### Changed
- Removed unused `tabs` permission from manifest (CWS review rejection — all chrome.tabs methods we use work without it).
- Removed floating paragraph hover button — threads now start via text selection only.
- API messages sent to backend are logged to browser console (DevTools → Console) for debugging context issues.

---

## [v1.2.3] — 2026-05-26

### Fixed
- Thread cards now reliably vanish when navigating between pages on ChatGPT, Gemini, and other SPAs. Added a 1s URL-change poll that catches navigations Next.js/Navigation API perform behind the scenes, plus orphan-card pruning for sites that swap content without changing the URL.
- Reverted the SPA save-race handler that was preventing card cleanup on navigation.

---

## [v1.2.2] — 2026-05-24

### Changed
- Selection popover auto-dismiss timeout tuned from 5s → 3s. The 5s value left the panel hanging long enough to still feel intrusive after a double-click.

---

## [v1.2.1] — 2026-05-24

### Fixed
- Selection popover now auto-dismisses after 5 seconds of no interaction, so double-clicking a word to read or copy it no longer leaves a panel hanging on the page. Hovering the popover pauses the timer.

---

## [v1.2.0] — 2026-05-24

### Added
- Thinking-dots indicator in the assistant bubble while waiting for the first token.
- Friendly toast on Google Docs editor URLs explaining canvas-text limitation.
- Dashboard activity tiles: questions asked / todos / saved, live-updating via `chrome.storage.onChanged` (no manual refresh).
- "Restore purchase" now opens a Stripe-verified link instead of accepting an email alone — closes a takeover hole where anyone who knew a Pro email could move the subscription to their own device.

### Fixed
- Closing a thread no longer erases it from the dashboard history index.
- SPA route changes (Gemini / Notion / single-page docs) no longer lose in-flight thread edits — saves flush against the old URL before navigation.
- Threads now flush on tab close / page hide so debounced saves don't get dropped on quick exits.

---

## [v1.1.0] — earlier

(Pre-changelog. See `git log` for details.)
