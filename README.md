<div align="center">
  <img src="public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>BYOK Chrome Extension Agent — your browser, augmented with the LLM you already pay for.</strong></p>
  <p>
    <a href="#install">Install</a> ·
    <a href="#configuration">Configure</a> ·
    <a href="PRIVACY.md">Privacy</a> ·
    <a href="CHANGELOG.md">Changelog</a> ·
    <a href="docs/ROADMAP.md">Roadmap</a>
  </p>
</div>

---

## Why Pie

Pie turns any modern Chromium browser into an AI agent — page understanding,
multi-step task automation, and tab management — without subscribing to yet
another AI service. You bring your own API key (Anthropic, OpenAI,
OpenRouter, or any of four China-region providers); Pie keeps it encrypted
locally and talks directly to your provider.

- **Your key, your data.** Encrypted at rest with AES-GCM in
  `chrome.storage.local`. Pie has no backend, no telemetry, no proxy. See
  [PRIVACY.md](PRIVACY.md).
- **Side panel, not pop-up.** Pie lives in Chrome's side panel and stays
  open while you browse — chat, run agent tasks, manage tabs without losing
  context.
- **Native tool calling.** Anthropic `tool_use` blocks and OpenAI
  `function_calling` plug straight into the agent loop, no JSON-mode
  workarounds.
- **Skills as a first-class object.** Save a prompt template with a scoped
  tool whitelist; run it as `/skill_name`. The agent can author its own
  skills, too — gated by an 8-guard capability boundary so they cannot
  expand their own privileges.
- **Asks before it acts.** Every high-risk action (form submit, sensitive
  field, raw CDP input, cross-origin tab op, closing a pinned tab) is
  gated by a confirm card showing the exact action, raw arguments, and
  affected origin — so you stay in informed control.
- **Multi-session, durable.** Conversations survive Service Worker
  restarts; archived sessions evict on storage pressure (LRU + 30-day hard
  delete).

## Features

### Page understanding
Ask questions about the page you're on. Pie extracts visible text (with
hardened scrubbing of credential fields) and sends only that to the LLM.
Page snippets are wrapped in `<untrusted_*>` markers in the prompt to
defeat prompt-injection attempts from page DOM.

### Agent automation with tool calling
Describe a task in natural language. The LLM plans steps and executes
them through Pie's tool registry, using your provider's native
tool-calling protocol — Anthropic `tool_use` blocks for Claude, OpenAI
`function_calling` for everyone else. The built-in toolset covers:

- **DOM actions** — click, type, select, scroll, structured snapshot of
  interactive elements (links, buttons, inputs)
- **Cross-tab tools** — list, activate, close, group / ungroup, move,
  fetch readable content from another tab
- **CDP keyboard** (opt-in, off by default) — `Input.dispatchKeyEvent`
  and `Input.insertText` for canvas-based editors like Lark Docs and
  Google Docs, where standard DOM events are not honored
- **Skill meta-tools** — the agent can create / update / delete / list
  its own skills (see *Skill system* below)

Three cross-tab skills ship built-in: `auto_group_tabs`,
`close_duplicate_tabs`, `close_inactive_tabs`.

### Skill system
Skills are saved prompt templates with explicit tool whitelists. Open
**Settings → Skills** to create, edit, or delete your own — name, prompt
template, parameter JSON schema, and the exact set of tools that skill
is allowed to call. Run any skill from chat by typing `/skill_name`.

The agent itself can author skills via `create_skill` / `update_skill` /
`delete_skill` meta-tools — useful for capturing a workflow the model
just walked through, so it can be replayed in the next session. An
agent-authored skill is tainted with `author='agent'` and triggers a
one-time confirmation card on its first run; a skill the model invented
never silently executes the next time around.

A skill cannot escape its declared tool whitelist. Eight capability-grant
invariants are enforced on every skill mutation — hard size caps (≤8 KB
prompt template, ≤2 KB parameter schema), forbidden meta-tool nesting,
1 MB per-installation storage budget, name validation against the live
tool registry — so a runaway skill cannot widen its own privileges.

### High-risk operation approval
Pie classifies every tool call before it runs. Anything irreversible or
cross-origin requires you to approve a confirmation card first.
**High-risk** triggers include: submitting forms, typing into password
/ payment / email fields, raw keyboard input via CDP, closing a pinned
tab, and any cross-origin tab operation.

The confirm card shows you:

- The exact tool name and the raw argument the agent intends to pass
  (so you can spot a mistake or a prompt-injected instruction in the
  page DOM before it runs)
- The origin and tab title for each affected tab, called out
  separately when the action would cross the original task's pinned
  origin
- An **Approve** / **Reject** pair, plus a task-level **Discard**
  option for when you want to abandon the agent's plan entirely

The CDP keyboard-simulation feature is **off by default** — you opt in
from Settings before it can be attached at all. If you reject three
actions on the same task, Pie terminates the task automatically rather
than burning your tokens on a plan you've already disagreed with.

### Supported providers

| Provider | Notes |
|---|---|
| Anthropic Claude | Native API + native `tool_use` |
| OpenAI | OpenAI `function_calling` |
| OpenRouter | OpenAI-compatible |
| MiniMax | OpenAI-compatible |
| ZhiPu (智谱) | OpenAI-compatible |
| Bailian (百炼) | OpenAI-compatible |

Adding a provider is a registry entry plus a host permission. Gemini and
local Ollama are on the [roadmap](docs/ROADMAP.md).

## Install

Pie ships in two end-user channels and one source-build channel. Pick
whichever fits.

Requires a Chromium-based browser with side-panel support — Chrome 114+,
Edge, Brave, Arc, etc.

### Option 1 — Chrome Web Store (recommended)

> *Pending review.* The CWS listing will appear here once Google's
> review completes; until then, use Option 2 for a one-click install.

Click **Add to Chrome**, then pin Pie to the toolbar.

### Option 2 — GitHub Release zip (unpacked install)

For users who want to install the same artifact without the Web Store,
or while the listing is still under review:

1. Download the latest `pie-x.y.z.zip` from the
   [Releases page](https://github.com/WiseriaAI/Pie/releases)
2. Unzip it to a directory you'll keep around (Chrome reads from this
   directory at runtime — don't delete it after install)
3. Open `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the unzipped directory
6. Pin Pie to the toolbar; click the icon to open the side panel

Updates: download the next release zip, replace the directory contents,
and click **Reload** on Pie's card in `chrome://extensions`.

### Option 3 — Build from source (contributors)

If you want HMR, are sending a PR, or just don't trust prebuilt
binaries:

```bash
git clone https://github.com/WiseriaAI/Pie.git
cd Pie
pnpm install
pnpm build
```

Then load the generated `dist/` directory as an unpacked extension
(steps 3–6 above). For the inner dev loop see [Development](#development)
below.

## Configuration

1. Open the side panel and switch to the **Settings** tab
2. Add a provider entry — paste your API key, choose a model
3. Switch back to **Chat** and send a message

Your key is encrypted before it lands in `chrome.storage.local`. The
encryption key itself is generated locally on first run and never leaves
the device.

## Privacy & security

- BYOK: your API key never leaves the device, except as an `Authorization`
  header on direct provider API calls
- All page content delivered to the LLM is wrapped in `<untrusted_*>` tags,
  hardening against prompt injection from page DOM
- Cross-origin tab actions and high-risk DOM actions require an explicit
  confirm card — Pie shows you exactly what would happen, on which origin,
  before it runs
- No telemetry, no analytics, no third parties

Full policy: [PRIVACY.md](PRIVACY.md).

## Development

```bash
pnpm install
pnpm dev          # Vite dev server with HMR
pnpm test         # Vitest, single run
pnpm test:watch   # Vitest, watch mode
pnpm build        # Production build to dist/
```

When developing, load the unpacked extension from `dist/` (after the first
`pnpm dev` run), and click the **Reload** button in `chrome://extensions`
after each service-worker change.

### Tech stack

- Chrome Extension Manifest V3
- React 19 + TypeScript 6
- TailwindCSS 4 (Vite plugin, no config file)
- Vite 8 + `@crxjs/vite-plugin` 2.4
- pnpm

### Project layout

| Path | Purpose |
|---|---|
| `src/background/` | Service Worker — message routing, agent loop dispatch, keep-alive |
| `src/sidepanel/` | React side-panel UI (Chat, Settings, session drawer) |
| `src/lib/model-router/` | Unified LLM interface; per-provider streaming + tool calling |
| `src/lib/agent/` | ReAct loop, tool registry, risk classifier, prompt builder |
| `src/lib/dom-actions/` | Self-contained DOM action functions injected via `executeScript` |
| `src/lib/skills/` | Skill framework: types, storage, built-in skills |
| `src/lib/sessions/` | Session lifecycle: persistence, archive, multi-session sandbox |

Architectural notes and invariant traces live in `docs/solutions/`. The
project's compound-engineering notes and contributor guidance are in
[`CLAUDE.md`](CLAUDE.md).

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the deferred-milestone
backlog. Highlights:

- Gemini provider
- Local model support via Ollama
- Keyboard shortcuts
- Page-URL-matched skill auto-trigger
- Operation recording → skill autogeneration

## Versioning & releases

Pie follows [Semantic Versioning](https://semver.org). Release notes live
in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE) — © 2026 Pie Project Contributors.
