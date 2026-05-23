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

### Added
- Thinking-dots indicator in the assistant bubble while waiting for the first token.
- Friendly toast on Google Docs editor URLs explaining canvas-text limitation.
- Dashboard activity tiles: questions asked / todos / saved.
- Live-updating dashboard via `chrome.storage.onChanged` (no manual refresh).

### Fixed
- Closing a thread no longer erases it from the dashboard history index.

---

## [v1.1.0] — earlier

(Pre-changelog. See `git log` for details.)
