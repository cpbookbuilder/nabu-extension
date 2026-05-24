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
