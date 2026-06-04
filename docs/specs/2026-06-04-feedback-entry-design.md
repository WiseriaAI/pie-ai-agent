# Feedback Entry + `/report-issue` Skill — Design

Date: 2026-06-04
Status: Approved (pending email address)
Scope: `pie-ai-agent` only (no backend changes)

## Goal

Give users two zero-backend ways to send feedback, surfaced from Settings:

1. **GitHub** — a one-click prefilled "new issue" page for general feedback, plus a
   built-in `/report-issue` skill that lets the agent compose a session-specific bug
   report from the current conversation and open a prefilled issue page for the user
   to review and submit.
2. **Email** — a `mailto:` link prefilled with environment info. No server required.

## Non-Goals

- No in-extension submission endpoint / backend (would require infra; out of scope —
  `mailto:` and GitHub prefill cover the need at zero cost).
- The agent NEVER auto-submits an issue. The user always reviews and clicks Submit on
  GitHub (they are already logged in).
- No DOM form-filling on GitHub. We use **URL query-param prefill** — robust against
  GitHub UI changes and preserves user review.

## Surfaces

Two independent surfaces with complementary roles.

### Surface A — Settings → `configs` tab, new `Feedback` section

A new `<section>` at the bottom of the `configs` tab in `Settings.tsx`, sibling to the
existing Language and Experimental sections (matches existing structure; smallest change).
Contains two actions:

**"Report on GitHub" button**
- On click, opens (via `window.open(url, "_blank")`) a prefilled new-issue URL:
  ```
  https://github.com/WiseriaAI/pie-ai-agent/issues/new?labels=user-report&body=<encoded>
  ```
- Prefilled `body` template (built in React, where this metadata is available):
  - Extension version: `chrome.runtime.getManifest().version`
  - Browser UA: `navigator.userAgent`
  - Active config: provider · model (from `getActiveInstance()` → instance provider/model)
  - UI locale: resolved `ui_locale`
  - A "## What happened?" heading left blank for the user to fill.
  - A guidance line: *"To report a problem about a specific task, go back to that chat
    and type `/report-issue` — the agent will draft the report for you."*

**"Email feedback" button**
- A `mailto:` link/button:
  ```
  mailto:<FEEDBACK_EMAIL>?subject=Pie%20Feedback&body=<same env skeleton>
  ```
- `FEEDBACK_EMAIL` is a single exported constant (placeholder until the real dedicated
  address is decided — change one line later). Centralize it so both the mailto and any
  future reuse read from one source.

A small shared helper builds the env-info text block so the GitHub body and the mailto
body stay identical. Lives in a new module, e.g. `src/lib/feedback.ts`, exporting
`FEEDBACK_EMAIL`, `GITHUB_REPO`, `buildEnvBlock()`, `buildGithubNewIssueUrl()`,
`buildFeedbackMailto()`.

### Surface B — built-in `/report-issue` skill (in-session, agent-driven)

A new built-in `SkillPackage` added to `BUILT_IN_SKILL_PACKAGES` in `src/lib/skills/builtin.ts`.
The audit guard `EXPECTED_BUILT_IN_SKILL_IDS` MUST be updated in lock-step (it throws at
import time otherwise) — add `report_issue`. (The spec convention doc referenced by the
guard, `docs/specs/2026-05-08-skill-tool-convention-design.md`, allows adding builtins as
long as the set stays in sync.)

Skill id: `report_issue`. Name: `Report Issue`. Triggered by the user typing
`/report-issue` in the chat that exhibited the problem (so the conversation context the
agent needs is already in its window).

Skill body (natural-language instructions to the agent):

1. Review the **current conversation** and summarize: what the user was trying to do,
   what went wrong, repro steps, expected vs. actual.
2. **Privacy boundary**: write a SUMMARY only. Do NOT paste raw `<untrusted_*>` page
   snapshots, and never include secrets (passwords, tokens, API keys, personal data)
   even if they appeared in the session. This issue is public.
3. Compose a concise title and a Markdown body with sections: *What happened*,
   *Steps to reproduce*, *Expected*, *Actual*, *Environment* (include what is known from
   the session; leave a "version: (please confirm)" line since the agent cannot read the
   extension version — the user fills it on review).
4. `encodeURIComponent` the title and body and build:
   ```
   https://github.com/WiseriaAI/pie-ai-agent/issues/new?labels=user-report&title=<t>&body=<b>
   ```
   Call `open_url` with that URL.
5. Call `done` with a one-line note: "Opened a prefilled GitHub issue — please review and
   submit." The agent must NOT attempt to submit it.

Declare `capabilities: { tools: ["open_url"] }` for documentation/consistency (capabilities
are advisory metadata; `use_skill` returns the body and the agent uses regular tools —
`open_url`/`done` are always available).

## Data Flow

```
Settings "Report on GitHub"  ──► buildGithubNewIssueUrl(envBlock) ──► window.open ──► GitHub (user submits)
Settings "Email feedback"    ──► buildFeedbackMailto(envBlock)    ──► mailto:      ──► mail client
/report-issue (in chat)      ──► agent summarizes session ──► open_url(prefilled) ──► GitHub (user submits)
```

## i18n

All new user-facing strings go into BOTH `src/lib/i18n/dictionaries/en.ts` and
`zh-CN.ts` (the `dictionary-parity.test.ts` enforces parity). Keys under a new
`settings.feedback.*` namespace: section title, GitHub button label, email button label,
the guidance line. The skill body itself is English prose (consistent with existing
builtin skills, which are English).

## Testing

- Unit test `src/lib/feedback.ts`: `buildGithubNewIssueUrl` and `buildFeedbackMailto`
  produce correctly encoded URLs; `buildEnvBlock` includes version/UA/provider·model/locale.
- The existing builtin audit guard + `dictionary-parity` test cover the skill-id set and
  i18n parity automatically (they throw/fail if we forget to sync).
- No new test needed for the React section beyond what the helpers cover (it is thin
  wiring); follow the existing Settings sections' untested-wiring precedent.

## Open Item

- **`FEEDBACK_EMAIL` value** — pending the user's dedicated feedback address. Ships with a
  placeholder constant; swap one line when decided.
