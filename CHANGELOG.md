# Changelog

> **Per-release notes have moved.** Up-to-date notes for every release are
> published on the [GitHub Releases page](https://github.com/WiseriaAI/pie-ai-agent/releases)
> and mirrored in [`docs/release-notes/`](docs/release-notes/). The entries
> below are kept for early pre-1.0 history only.

Pie adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-05-04

First MVP pre-release under the **Pie** brand.

### Added
- **Multi-session sandbox** — every conversation has an isolated pinned tab,
  port routing, and CDP owner token. Confirm cards from one session never
  appear in another, and a write-tool dispatch is rejected when another
  session pins the same tab.
- **Session sidebar** — drawer-style list with a 24×24 toggle in the top
  bar, new-session button, status icons (active / paused / failed /
  archived), Restore / Delete-forever for archived rows, and a storage
  indicator that turns red past 7.5 MB.
- **LRU archive + 30-day hard delete** — Pie auto-archives the oldest
  inactive session when `chrome.storage.local` crosses 8 MB, and hard-deletes
  archive bundles older than 30 days on side-panel mount.
- **LLM-generated session titles** — the first user message kicks off an
  asynchronous title generation that escapes the message inside an
  `<untrusted_user_message>` wrapper, strips emoji, and truncates to 30
  characters. Falls back to a 40-character truncation of the first message
  if the call fails.
- **Multi-turn conversation** — agent runs now see prior chat / agent turns
  in the same session, with a React-segment-aware sliding window and a
  per-provider token budget.

### Changed
- **Rebranded** from "Chrome AI Agent" to **Pie**. Manifest `name`,
  package name, side-panel title, and console logs all updated. Source-level
  DOM attributes (`data-chrome-ai-agent-idx`) are unchanged in this release
  to avoid a structural refactor; they will move to `data-pie-idx` in a
  follow-up.
- **License switched from MIT to Apache License 2.0.** Apache 2.0 adds an
  explicit patent grant and a "modification notice" requirement on
  redistributions, both of which are healthier defaults for a project that
  expects external contributions. `package.json` SPDX identifier updated to
  `Apache-2.0`.

### Notes
- No new Chrome permissions are introduced in 0.5.0; the rebrand and
  multi-session work reuse the permission set granted in 0.4.0.

## [0.4.0] — 2026-05-03

### Added
- 7 cross-tab agent tools: `list_tabs`, `get_tab_content`, `close_tabs`,
  `activate_tab`, `group_tabs`, `ungroup_tabs`, `move_tabs`.
- 3 built-in tab skills: `auto_group_tabs`, `close_duplicate_tabs`,
  `close_inactive_tabs`.
- `tabGroups` Chrome permission (Chrome will request re-authorization on
  upgrade).

### Security
- Per-call cross-origin args introspection forces a high-risk confirm card
  for any tab operation that targets an origin different from the pinned
  one.
- Multi-tab confirm cards now render an origin summary row and meet the
  baseline a11y contract (`role=dialog` + `aria-labelledby` + per-row
  `aria-label`).
- Hardened the `<untrusted_skill_params>` wrapper against agent-supplied
  wrapper-tag literals (closes the `renderTemplate` wrapper-escape vector
  reported by adversarial review).

## Earlier versions

0.3.x and earlier are not formally tagged. See `git log` for history; the
broad-strokes timeline lives in `CLAUDE.md` under "Progress".
