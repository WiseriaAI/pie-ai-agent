<div align="center">
  <img src="public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Browser-automation agent for Chrome — natural-language tasks executed through native tool calling, scoped Skills, CDP keyboard control, and a sandboxed, prompt-injection-resistant execution model.</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Available in the Chrome Web Store" /></a>
  </p>
  <p>
    <strong>English</strong> ·
    <a href="README.zh-CN.md">简体中文</a>
  </p>
  <p>
    <a href="#install">Install</a> ·
    <a href="#configuration">Configure</a> ·
    <a href="PRIVACY.md">Privacy</a> ·
    <a href="CHANGELOG.md">Changelog</a> ·
    <a href="docs/ROADMAP.md">Roadmap</a> ·
    <a href="docs/ARCHITECTURE.md">Architecture</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">Archive</a>
  </p>
</div>

---

## Why Pie

Pie turns Chrome into a browser-automation agent. Describe a task in
natural language; the LLM plans steps and executes them through a typed
tool registry — DOM actions, cross-tab orchestration, and CDP-level
keyboard input for canvas editors that don't honor standard DOM events.
Workflows can be saved as Skills with explicit tool whitelists. Tools
run without per-action approval prompts; page content reaches the model
only inside `<untrusted_*>` wrappers, tools are split into read vs. write
classes with cross-session locks, and each session is sandboxed — so
automation stays contained. BYOK: paste your own API key from any of nine
LLM providers — encrypted locally, no Pie backend, no telemetry.

- **Browser automation through native tool calling.** The LLM uses
  Anthropic `tool_use` blocks or OpenAI `function_calling` to drive a
  typed tool registry — DOM actions (click, type, select, scroll,
  structured snapshot), cross-tab orchestration (list / activate / close /
  group / move / fetch readable content), and opt-in CDP keyboard
  injection (`Input.dispatchKeyEvent`, `Input.insertText`) for canvas
  editors like Lark Docs and Google Docs.
- **Skills as a first-class object.** Save a prompt template with a scoped
  tool whitelist; run it as `/skill_name`. The agent can author its own
  skills too — gated by an 8-guard capability boundary so they cannot
  expand their own privileges.
- **Contained by design.** Tools run without a per-action approval click.
  Containment comes from defense in depth: page and third-party content
  reaches the model only inside `<untrusted_*>` wrappers (prompt-injection
  defense), tools are classified read vs. write with cross-session write
  locks, and each session is sandboxed (its own port, pinned tabs, and CDP
  owner token). CDP keyboard injection is off until you opt in.
- **Multi-session, durable.** Conversations survive Service Worker
  restarts; archived sessions evict on storage pressure (LRU + 30-day hard
  delete).
- **Side panel, not pop-up.** Pie lives in Chrome's side panel and stays
  open while you browse — chat, run agent tasks, manage tabs without
  losing context.
- **BYOK.** Bring your own API key from any of nine LLM providers.
  Encrypted at rest with AES-GCM in `chrome.storage.local`. No Pie
  backend, no telemetry, no proxy. See [PRIVACY.md](PRIVACY.md).

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
agent-authored skill is tagged with `author='agent'` and is bound by the
same capability-grant invariants below — it can only call tools it was
explicitly granted and cannot widen its own privileges.

A skill cannot escape its declared tool whitelist. Eight capability-grant
invariants are enforced on every skill mutation — hard size caps (≤8 KB
prompt template, ≤2 KB parameter schema), forbidden meta-tool nesting,
1 MB per-installation storage budget, name validation against the live
tool registry — so a runaway skill cannot widen its own privileges.

### Safety model
Pie runs tools directly — there is no per-action approval card in the hot
path. Safety is layered instead:

- **Prompt-injection containment.** Page content, tab metadata, and skill
  arguments reach the model only inside `<untrusted_*>` wrappers, and never
  in the system prompt — so text in a page's DOM can't be read as a trusted
  instruction.
- **Read vs. write tool classes.** Every tool is declared read or write at
  build time. Write-class tools are blocked from touching a tab another
  session has pinned (cross-session write lock), so concurrent sessions
  can't corrupt each other.
- **Per-session sandbox.** Each session has its own streaming port, its own
  set of pinned tabs, and a CDP owner token, so one task can't hijack
  another's tab or debugger session.
- **CDP keyboard injection is off by default** — you opt in from Settings
  before it can attach at all.
- **Skills can't self-escalate** — enforced by the capability-grant
  invariants above.

The one approval you'll still see is at **resume** time: if you pause a
task and its pinned tab was closed or navigated to a different origin, Pie
shows a drift card before continuing rather than acting on the wrong page.

### Supported providers

| Provider | Notes |
|---|---|
| Anthropic Claude | Native API + native `tool_use` |
| OpenAI | OpenAI `function_calling` |
| Gemini | Native API |
| OpenRouter | OpenAI-compatible |
| DeepSeek | OpenAI-compatible |
| MiniMax | OpenAI-compatible |
| ZhiPu (智谱) | OpenAI-compatible |
| Bailian (百炼) | OpenAI-compatible |
| MiMo (小米) | Anthropic-compatible |

Adding a provider is a registry entry plus a host permission. Local
Ollama is on the [roadmap](docs/ROADMAP.md).

## Install

Pie ships in two end-user channels and one source-build channel. Pick
whichever fits.

Requires a Chromium-based browser with side-panel support — Chrome 114+,
Edge, Brave, Arc, etc.

### Option 1 — Chrome Web Store (recommended)

Install from the **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)** — click **Add to Chrome**, then pin Pie to the toolbar. Chrome keeps it up to date automatically.

### Option 2 — GitHub Release zip (unpacked install)

For users who prefer to install the same artifact without the Web Store
(e.g. an offline, self-managed, or policy-restricted setup):

1. Download the latest `pie-x.y.z.zip` from the
   [Releases page](https://github.com/WiseriaAI/pie-ai-agent/releases)
2. Unzip it to a directory you'll keep around (Chrome reads from this
   directory at runtime — don't delete it after install)
3. Open `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the unzipped directory
6. Pin Pie to the toolbar; click the icon to open the side panel

#### Upgrading without data loss

Chrome derives the extension ID from the unpacked directory's path, and
your sessions / encrypted API keys / Skills are scoped to that ID in
`chrome.storage.local`. To carry them across releases, **upgrade in
place** — don't unzip the new release to a different folder.

1. Open `chrome://extensions` and find Pie's card. Note the unpacked
   directory path (shown under the card, or via **Details** → "Source")
2. Delete the contents of that directory, but keep the directory itself
3. Unzip the new `pie-x.y.z.zip` into that same directory
4. Click the **↻ reload** icon on Pie's card

> ⚠️ Do **not** click **Remove** on the old card. Remove drops the
> extension's `chrome.storage.local` along with the encrypted API keys
> and chat history. If you already removed it, re-add provider keys
> from Settings; chat history can't be recovered.

Web Store users (Option 1) skip this section — Chrome auto-updates the
extension and storage carries over automatically.

### Option 3 — Build from source (contributors)

If you want HMR, are sending a PR, or just don't trust prebuilt
binaries:

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
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
- Tools run without a per-action approval prompt; containment comes from
  read/write tool classes with cross-session write locks and per-session
  sandboxing (isolated port, pinned tabs, CDP owner token)
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
| `src/lib/agent/` | ReAct loop, tool registry, read/write tool classification, untrusted-content wrappers, prompt builder |
| `src/lib/dom-actions/` | Self-contained DOM action functions injected via `executeScript` |
| `src/lib/skills/` | Skill framework: types, storage, built-in skills |
| `src/lib/sessions/` | Session lifecycle: persistence, archive, multi-session sandbox |

Architectural notes and invariant traces live in `docs/solutions/`. The
project's compound-engineering notes and contributor guidance are in
[`CLAUDE.md`](CLAUDE.md).

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the deferred-milestone
backlog. Highlights:

- Local model support via Ollama
- Keyboard shortcuts
- Page-URL-matched skill auto-trigger
- Operation recording → skill autogeneration

## Versioning & releases

Pie follows [Semantic Versioning](https://semver.org). Release notes live
in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE) — © 2026 Pie Project Contributors.
