# Pie Architecture

This document is the engineering-level companion to [`README.md`](../README.md)
and [`CLAUDE.md`](../CLAUDE.md). It describes how Pie is structured as a
running browser extension, how the major modules are designed, and how the
invariants enforced across them line up. Read it after the README if you are
joining the project, reviewing a non-trivial PR, or trying to locate where a
behavior is implemented.

For phase-level invariant traces (the "what specifically broke / how was it
fixed" record per milestone), see [`docs/solutions/`](./solutions/). This file
gives you the map; those files give you the receipts.

---

## §1 Overview & Context Boundaries

Pie is a Chrome Manifest V3 extension. Three Chrome runtime contexts cooperate
to deliver a single agent task; they are isolated by Chrome's process model
and communicate only through structured channels.

```
                        ┌─────────────────────────────────────────────┐
                        │                  USER                       │
                        │   (clicks, types, approves confirm cards)   │
                        └────────────────┬────────────────────────────┘
                                         │
                                         ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │                       Side Panel (React 19)                       │
   │   src/sidepanel/  —  Chat / Settings / Skills / Session drawer    │
   │                                                                   │
   │   - Renders DisplayMessage[] from session_${id}_meta              │
   │   - Composes user messages, dispatches chat-start                 │
   │   - Renders confirm cards from SessionConfirmRequestMessage       │
   └────────────────┬──────────────────────────────────┬───────────────┘
                    │                                  │
       chat-start  │                                  │  chat-stream-${sessionId}
       confirm-*   │                                  │  (per-session port —
       (messages)  │                                  │   long-lived for streaming)
                    ▼                                  ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │                Service Worker (background/index.ts)               │
   │                                                                   │
   │   - Message router (chrome.runtime.onMessage / onConnect)         │
   │   - Per-session port + 25s keep-alive (getPlatformInfo)           │
   │   - Agent loop dispatcher (one in-flight task per session)        │
   │   - CDP debugger lifecycle (chrome.debugger attach/detach)        │
   │   - Pinned-tab registry, cross-session R7 lock                    │
   │   - Cold-start session-recovery sweep                             │
   └───┬──────────────────┬─────────────────────┬────────────────────┬─┘
       │                  │                     │                    │
       │ HTTPS direct     │ executeScript       │ chrome.debugger    │ IndexedDB ("pie" DB)
       │ (Authorization   │ (self-contained     │ (Input.dispatch    │ (encrypted
       │  header)         │  injected fn)       │  KeyEvent etc.)    │  instance keys,
       ▼                  ▼                     ▼                    │  session state,
   ┌─────────┐       ┌──────────┐         ┌──────────┐               │  skills, …)
   │ LLM     │       │ DOM      │         │ CDP      │               │
   │ Provider│       │ Action   │         │ Target   │               │
   │ (11)    │       │ (page    │         │ (canvas  │               │
   │         │       │  world)  │         │  editor) │               │
   └─────────┘       └──────────┘         └──────────┘               │
                                                                     │
                                                                     │
   ┌───────────────────────────────────────────────────────────────┐ │
   │          IndexedDB "pie" DB (apiKeys AES-GCM at rest)         │◀┘
   └───────────────────────────────────────────────────────────────┘
```

### 1.1 Where code lives by runtime context

| Runtime context | Lives in | Lifetime |
|---|---|---|
| **Side panel** | `src/sidepanel/` | Open while user has the panel mounted; closes with the user-visible side panel |
| **Service Worker** | `src/background/` (+ shared `src/lib/`) | Chrome-managed; can suspend after ~30s idle, hence the 25s keep-alive ping |
| **Injected page scripts** | `src/lib/dom-actions/` (functions only) | One-shot per `executeScript` call; no closures, no shared state |

Side Panel ↔ SW use `chrome.runtime.connect()` + a per-session `Port`, **not**
`sendMessage`, because the agent loop streams `text-delta` and `tool_use`
events that can outlast a single message round-trip. SW ↔ page is one-shot:
`chrome.scripting.executeScript({ func, args })` runs a self-contained function
in the page world and returns a serializable result.

### 1.2 Why side panel and not pop-up

Pop-up windows close on every focus change; an agent task that runs for 30
seconds across several tabs would lose its UI state midway. Side panel
persists across navigation, focus changes, and tab switches, so the streaming
chat / confirm-card UX stays attached to the running task. This is the
single biggest reason `manifest.json` declares `"side_panel"` and `"activeTab"`
is **not** sufficient for host access (we need `<all_urls>` because the
panel is always attached but the active tab keeps changing).

---

## §2 Layered Architecture

Inside the SW + Side Panel + lib code, the logical layers are:

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI Layer       │  src/sidepanel/                                    │
│                 │  React 19 components, hooks, panel-side state.     │
│                 │  Reads session_${id}_meta.messages on mount;       │
│                 │  re-renders on storage onChanged.                  │
├──────────────────────────────────────────────────────────────────────┤
│  Agent Runtime  │  src/lib/agent/  (loop, prompt, risk, window,     │
│                 │  history-validation, untrusted-wrappers, tools/)  │
│                 │  + src/background/  (dispatcher, CDP, recovery)   │
│                 │  Owns the ReAct iteration: snapshot → LLM →       │
│                 │  classify → confirm gate → execute → record.      │
├──────────────────────────────────────────────────────────────────────┤
│  Model Router   │  src/lib/model-router/                             │
│                 │  Provider-neutral streamChat() with native tool    │
│                 │  calling. 11 providers, 5 of them via the shared   │
│                 │  OpenAI-compat core.                               │
├──────────────────────────────────────────────────────────────────────┤
│  Storage &      │  src/lib/sessions/, src/lib/skills/,               │
│  Persistence    │  src/lib/instances.ts, src/lib/crypto.ts,          │
│                 │  src/lib/migration-v2.ts                           │
│                 │  Encrypted instance keys, session lifecycle state, │
│                 │  skill registry, config migrations.                │
└──────────────────────────────────────────────────────────────────────┘
```

The layering is enforced by import direction, not by package boundaries —
TypeScript path aliases (`@/lib/...`) cross all layers freely, but the
actual dependency graph is acyclic: UI imports from Agent Runtime and
Model Router; Agent Runtime imports from Model Router and Storage;
Model Router imports from Storage (for streaming attachments); none of
the lower layers import from UI.

---

## §3 Core Module Designs

### 3.1 Model Router — `src/lib/model-router/`

**Responsibility**: present a single async-generator interface
(`streamChat(config, messages, signal, tools): AsyncGenerator<StreamEvent>`)
across 8 LLM providers, normalizing native tool calling to a provider-neutral
`ToolUseBlock` / `ToolResultBlock` IR.

**Key files**:

| File | Role |
|---|---|
| `index.ts` | Public API: `streamChat`, `chat`, `chatMessagesToAgent` adapter |
| `types.ts` | `AgentMessage`, `ContentBlock`, `StreamEvent`, `ToolDefinition` |
| `providers/registry.ts` | Per-provider metadata: `defaultBaseUrl`, `models[]`, capability flags (`vision`, `tools`, `maxContextTokens`) |
| `providers/index.ts` | id-keyed dispatch table: `streamChatByProvider[provider](...)` |
| `providers/_shared/openai-compat-core.ts` | Shared streaming + tool-calling logic for all 5 OpenAI-compatible providers |
| `providers/anthropic.ts` | Native Anthropic `tool_use` block streaming |
| `providers/gemini.ts` | Native Gemini API streaming |
| `providers/{openai,openrouter,deepseek,minimax,zhipu,bailian}.ts` | Thin wrappers over the shared core, each adding provider-specific headers via the `customHeaders` hook |
| `sse.ts` | SSE parser handling both `\n` and `\r\n` line endings |

**Design points**:

- **Two backends, eight surfaces**. Anthropic and Gemini have native
  protocols (different from OpenAI's chat-completions); the other six all
  speak OpenAI's chat-completions API and share `_shared/openai-compat-core.ts`.
  Adding a new OpenAI-compat provider is a 10-line `streamChat` wrapper +
  registry entry + manifest host_permission, no dispatch code change.
- **Provider-neutral IR**. The router converts every provider's native tool
  call format into `ToolUseBlock { id, name, input }` + `ToolResultBlock
  { toolUseId, content }`. The agent loop never sees `function_call` /
  `tool_calls` / `functionCall` differences.
- **`defaultBaseUrl` is the only authority**. The settings UI never exposes
  baseUrl (intentional simplification); pre-V2 user-supplied baseUrls are
  silently dropped during migration. This keeps provider switching from
  carrying stale URLs.
- **Per-message capability flags**. `ModelMeta.vision` and `.maxContextTokens`
  are per-model, not per-provider — the same provider may have one vision
  model and one text-only model. The agent loop reads these to decide
  whether to inline image attachments.

### 3.2 Agent Loop — `src/lib/agent/`

**Responsibility**: drive a ReAct (reason-act) iteration where each step
produces a page snapshot, calls the LLM with the snapshot + history, and
either executes a returned tool call or terminates.

**Key files**:

| File | Role |
|---|---|
| `loop.ts` | Main `runAgentLoop` async generator; orchestrates one task end-to-end |
| `prompt.ts` | System prompt builder (capability inventory + safety rails) |
| `tools.ts` + `tools/` | Tool registry assembly: keyboard, skill-meta, tabs |
| `tool-names.ts` | Compile-time tool-name constants + build-time exhaustiveness gate |
| `risk.ts` | Pure tool-call risk classifier (see §3.3) |
| `untrusted-wrappers.ts` | Wrapper-tag escape helper (see §3.3) |
| `window.ts` + `window-token-budget.ts` | Sliding-window history truncation under per-model token budget |
| `history-validation.ts` | Tool_use ↔ tool_result ID consistency check before each LLM call |
| `synthesize-agent-turn.ts` | Compresses a completed task's IR into a single user-visible assistant message |
| `image-hydration.ts` | Re-attaches in-memory image bytes onto rehydrated history (storage carries placeholders only — see R10/R14) |
| `wait-for-settle.ts` | Heuristic post-action page-quiescence wait |

**Loop shape (simplified)**:

```
runAgentLoop(taskInput):
  agentMessages = [system, user(taskInput)]
  loop step in 0..MAX_STEPS:
    snapshot = injectAndRun(extractPageContentHardened, focusTabId)
    truncated = applyWindow(agentMessages, modelTokenBudget)
    for event in streamChat(modelConfig, truncated, signal, tools):
      yield event                             # → port → side panel
      if event is toolUse: collect
    if no toolUse:
      append assistant text; break
    for each toolUse:
      assessment = classifyRisk(toolUse, snapshot, ctx)
      if assessment.level === 'high':
        await userConfirm(toolUse, snapshot, tabTargets)
      result = await dispatch(toolUse, ctx)
      append tool_use + tool_result to agentMessages
      persistSnapshot(sessionId, agentMessages, stepIndex)
    step++
  emitDone(sessionId)
```

**Design points**:

- **One in-flight task per session**. The dispatcher rejects a second
  `chat-start` for a session that has a non-tombstone `SessionAgentState`.
  Concurrency across sessions is fine (different ports, different pinned
  tabs, different CDP `ownerToken`s).
- **Pin at task start, re-check every iteration**. The first iteration
  captures `(tabId, origin)` into `SessionMeta.pinnedTabs[0]` (in `task`
  pin mode). Every subsequent iteration calls `chrome.tabs.get(tabId)` and
  compares origin; if drift occurs, the loop pauses and emits an
  origin-change confirm. See [`docs/solutions/2026-05-02-cross-tab-trust-model.md`](./solutions/2026-05-02-cross-tab-trust-model.md).
- **Sliding window with per-model budget**. `window.ts` truncates the
  middle of `agentMessages` (keeping system + recent N) while honoring the
  active model's `maxContextTokens` minus a safety reserve. Token estimation
  uses character-length heuristics (no tokenizer in the SW bundle).
- **Snapshot-then-act is mandatory**. Every tool call sees a fresh snapshot
  taken on the same tick the LLM plans against. Agent-side caching of stale
  element indices was deliberately not added.
- **Tombstone on task end**. After success / fail / abort / max-steps, the
  loop writes `SessionAgentState { agentMessages: [], stepIndex: 0 }` so a
  future SW restart cannot mistake leftover IR for an in-flight task.

### 3.3 Risk Classifier & Untrusted Wrappers — `src/lib/agent/risk.ts`, `untrusted-wrappers.ts`

These two modules implement the security perimeter: what the LLM is allowed
to do without asking, and what page-supplied text is allowed to do once it
crosses into LLM context.

**Risk classifier** (`risk.ts`):

- **Pure function**, no side effects. Inputs: tool name, args, current
  snapshot, `RiskClassifyContext` (pinned tabs + tab-origin cache). Output:
  `{ level: 'low' | 'high', reason?: string }`.
- **Default-low + structural escalation**. The base case for any unmatched
  tool is `low`. High-risk triggers are explicit:
  - Form submit (`<button type=submit>`, `<input type=submit>`, dangerous
    keyword regex on click target text/aria-label)
  - Sensitive field detection (`type=password`, regex over text /
    placeholder / aria-label for `password|cvv|otp|card-number|…` and
    Chinese variants)
  - CDP keyboard tools (`dispatch_keyboard_input`, `press_key`) — always
    high; bypass DOM safety entirely
  - Cross-tab write tools (`close_tabs`, `group_tabs`, `ungroup_tabs`,
    `move_tabs`, `open_url`) — always high
  - Cross-origin args on read tools (`activate_tab`, `get_tab_content`)
  - Skill-meta CRUD (`create_skill`, `update_skill`) — high; the agent is
    requesting a new persistent capability
  - Screenshot tools — high; pixel data cannot be sanitized
- **Build-time exhaustiveness gates**. Two `for…throw` loops at module load
  time (`TAB_TOOL_NAMES` and `SCREENSHOT_TOOL_NAMES`) ensure every tool in
  the registry is consciously classified. A new cross-tab tool that ships
  without a risk decision throws on extension load — caught in `pnpm build`.

**Untrusted wrappers** (`untrusted-wrappers.ts`):

- **Single escape hatch** for content flowing from page → LLM. Page
  snapshots, tab metadata, skill arguments, and prior-task summaries are
  all wrapped in `<untrusted_X>...</untrusted_X>` tags inside **user-role**
  messages (never system role).
- **Hardened against wrapper-tag escape**. The escape function recognizes
  six wrapper tag names and rewrites any `<…/untrusted_X…>` sequence to
  `&lt;…&gt;` HTML entities, defending against:
  1. Plain ASCII closing
  2. Unicode confusable brackets (`‹›`, `〈〉` in three different code
     points, `＜＞`)
  3. Slash variants (`/`, `⁄`, `∕`)
  4. Closing tag with attributes
  5. Multi-slash close (`<//tag>`)
  6. Zero-width injection inside the tag name (stripped before regex)
- See [`docs/solutions/security-issues/2026-05-02-wrapper-tag-escape-attack-families.md`](./solutions/security-issues/2026-05-02-wrapper-tag-escape-attack-families.md)
  for the threat catalog and per-family test coverage.

### 3.4 Skill System — `src/lib/skills/`

**Responsibility**: persist user / agent-authored prompt templates as
addressable callable units; let the user invoke them from chat as
`/skill_name`, and let the agent author / update / delete its own via
meta-tools.

**Key files**:

| File | Role |
|---|---|
| `types.ts` | `SkillDefinition` + author taint (`'user' | 'agent'`) |
| `storage.ts` | CRUD over `skill_${id}` + `enabled_skills` array |
| `builtin.ts` | Three shipped skills: `auto_group_tabs`, `close_duplicate_tabs`, `close_inactive_tabs` |
| `slash.ts` | `/skill_name` parser for the chat composer |
| `index.ts` | `resolveSkillToTools` — turns a skill invocation into the agent loop's task input + tool whitelist |

**Design points**:

- **Skills are not free-form**. The agent's `create_skill` /
  `update_skill` meta-tools enforce eight capability-grant invariants at
  write time — see
  [`docs/solutions/2026-05-01-llm-capability-grant-invariants.md`](./solutions/2026-05-01-llm-capability-grant-invariants.md).
  Hard size caps (≤8 KB prompt template, ≤2 KB parameter schema), forbidden
  meta-tool nesting, 1 MB per-installation storage budget, and tool-name
  validation against the live registry are the headline guards.
- **Author taint**. `SkillDefinition.author` propagates from creator —
  agent-authored skills are tagged `'agent'` and trigger `create_skill` /
  `update_skill` to be classified as high-risk in `risk.ts`. A skill the
  model invented does not silently execute on a future turn without a
  confirm card the first time the user invokes it. (Pre-2026-05-06 there
  was an additional first-run-confirm gate; that gate was removed in
  issue #26 in favor of the simpler write-time confirm — see the
  `@deprecated` comments on `firstRunConfirmedAt` and `allowedTools`.)
- **`promptTemplate` is rendered into an untrusted wrapper**. When a skill
  is invoked, its rendered template (Handlebars-style `{{key}}` substitution
  + `JSON.stringify(args[key])`) is wrapped in `<untrusted_skill_params>`
  before being injected as the task input. A skill's template can therefore
  not exfiltrate arguments through prompt-injection-style tag escape.
- **Three built-ins ship enabled**. Built-in skills have `id` constants
  and `builtIn: true` so they cannot be deleted; the user can disable them
  via the SkillsList UI (`enabled_skills` array opt-out).

### 3.5 Session System — `src/lib/sessions/`

**Responsibility**: keep multiple concurrent chat conversations isolated
from each other, persist each one across SW restarts, and expose them via
the SessionDrawer UI.

**Key files**:

| File | Role |
|---|---|
| `types.ts` | `SessionMeta`, `SessionAgentState`, `SessionIndexEntry`, `SessionStatus` enum |
| `state-machine.ts` | Allowed status transitions: `active → paused / failed / archived`, etc. |
| `lifecycle.ts` | `createSession`, `archive`, `restore`, 30-day hard-delete sweep (no LRU auto-archive — IndexedDB has no fixed quota) |
| `storage.ts` | Atomic read-modify-write helpers; split-key persistence |
| `pinned-tab-registry.ts` | Cross-session R7 lock — one task may not yank another's pinned tab |
| `pin-state.ts` | `getEffectivePinMode` resolver (`auto` / `task` / `user`) |
| `title.ts` + `title-generator.ts` | Async LLM-titled sessions; first-message prefix fallback |
| `migration.ts` | Pre-V2 single-pin → multi-pin schema upgrade |

**Design points**:

- **Two-key split per session**. `session_${id}_meta` (panel-display state:
  messages, pinned tabs, title) and `session_${id}_agent` (LLM IR:
  `agentMessages`, `stepIndex`, `pendingConfirm`). The split keeps panel
  reads cheap and prevents the agent loop's per-step writes from racing
  the panel's `persistMessages`.
- **Status state machine**. Six legal transitions, encoded in
  `state-machine.ts`. `active → paused` happens on SW restart with
  in-flight IR; `paused → failed` happens when the user discards the
  R11 drift card. `archived` sessions live in `session_${id}_archived`
  (separate key, not loaded by the drawer's hot path).
- **Per-session port name**. `chat-stream-${sessionId}` — the SW knows
  which session a port belongs to without a separate handshake. A new
  panel mount opens a fresh port; the SW resumes streaming if a task is
  in flight.
- **Cross-session R7 lock** (`pinned-tab-registry.ts`). When two sessions
  both want to operate on tab 42, the second one's tool call gets
  rejected at dispatch time. Auto-mode sessions are excluded from the
  registry (no claim of ownership).
- **Cold-start recovery**. SW startup runs `session-recovery.ts` (in
  `src/background/`), which walks the index, clears every
  `pendingConfirm` (the resolver lived in SW memory, gone now), and
  transitions any session with `stepIndex > 0` from `active` to `paused`
  (or `failed` if `hasImageContent` — image bytes were not persisted, so
  resume would feed cache-miss markers). See
  [`docs/solutions/2026-05-02-session-as-first-class-persistent-layer-m1.md`](./solutions/2026-05-02-session-as-first-class-persistent-layer-m1.md).

### 3.6 DOM Actions / CDP Keyboard — `src/lib/dom-actions/`, `src/lib/keyboard-simulation.ts`, `src/background/cdp-session.ts`

These are the two write-side surfaces into the page; they are intentionally
implemented very differently because their threat models differ.

**DOM Actions** (`src/lib/dom-actions/`):

- One TypeScript function per action (click, type, select, scroll,
  snapshot). Each is **self-contained**: no closures, no imports beyond
  `@/lib/dom-actions/types`. The SW serializes `args` and passes them
  through `chrome.scripting.executeScript({ func, args })`, which runs
  the function in the page world.
- Snapshot is the central read primitive: `extractPageContentHardened`
  walks visible interactive elements, strips credential fields inline
  (parallel to but not sharing code with `risk.ts` — different runtime
  context, no module loading), and returns `PageSnapshot { elements,
  metadata, … }`. The snapshot returned is what the LLM sees wrapped in
  `<untrusted_page_content>`.
- DOM actions can never escalate risk — they execute in the page world,
  not the SW; their effect is bounded by Chrome's same-origin policy and
  any user gesture requirements native to the page.

**CDP Keyboard** (`src/background/cdp-session.ts` + `src/lib/keyboard-simulation.ts`):

- Off by default. Requires explicit opt-in from Settings before a
  `chrome.debugger.attach` ever runs.
- One CDP session per session (literally — `ownerToken = { sessionId,
  tabId }` is recorded when attaching, so a SW restart can detach
  cleanly). Detach happens on task end, on session end, and on
  `chrome.debugger.onDetach` fires (user-initiated detach via the Chrome
  DevTools yellow bar).
- Always-high risk. CDP keyboard events bypass DOM event listeners,
  visibility checks, and disabled-state checks. The risk classifier
  hard-codes both keyboard tool names to `high`, and the build-time gate
  in `tool-names.ts` ensures both names are listed in the screenshot /
  keyboard exhaustiveness sets.
- See [`docs/solutions/2026-04-28-cdp-keyboard-simulation-on-canvas-editors.md`](./solutions/2026-04-28-cdp-keyboard-simulation-on-canvas-editors.md)
  for the canvas-editor (Lark Docs / Google Docs) motivation and the
  CDP attach/detach lifecycle invariants.

### 3.7 Multi-Instance Config — `src/lib/instances.ts`, `src/lib/migration-v2.ts`, `src/lib/crypto.ts`

**Responsibility**: support `N` independent provider configurations of the
same provider (e.g. two OpenAI keys with different nicknames + models)
without forcing the user to copy-paste keys when switching.

**Key files**:

| File | Role |
|---|---|
| `instances.ts` | CRUD over `instance_${uuid}` (encrypted apiKey + nickname + model) + `instances_index` + `active_instance_id` |
| `crypto.ts` | AES-GCM helper using a locally-generated key stored under a fixed storage key |
| `migration-v2.ts` | Silent V1 (`provider_${id}` single config per provider) → V2 (`instance_${uuid}` arbitrary count) migration on first SW load |
| `provider-custom-models.ts` | Per-provider sticky pool of user-added model IDs (`pcm_${provider}`); shared across instances of the same provider |

**Design points**:

- **Per-instance encryption**. The `apiKey` field on each instance record is
  AES-GCM-encrypted; the AES key itself lives in the `config` store of the
  same IndexedDB database (not exfiltrating from the device is the threat
  model, not "key in RAM" — see PRIVACY.md). `crypto.ts` keeps a legacy
  fallback that reads the old `chrome.storage` key during an upgrade.
- **Snapshot at task start, not at iteration**. When a chat-start arrives,
  the SW resolves the active `ModelConfig` (active instance + active
  model + decrypted key) once and threads it through every iteration of
  that task's loop. Mid-task instance switches via `InstanceSelector`
  do not affect the in-flight task; they take effect on the next
  `chat-start`.
- **Per-session instance override**. `SessionMeta.instanceId` overrides
  the global `active_instance_id` for that session; useful when the user
  wants one chat on Claude Sonnet and another on a smaller cheap model.
- **V1 migration is one-shot, silent, and lossy on baseUrl**. V1 allowed
  user-supplied `baseUrl`; V2 dropped the field (the registry's
  `defaultBaseUrl` is authoritative). The migration logs the dropped
  values to a one-time `migration_v2_mapping` storage key for support
  diagnostics, but the in-app UX is unchanged.

---

## §4 Cross-Cutting Design Principles

These show up across multiple modules; they are listed here once instead
of repeated per-module.

### 4.1 Encrypted at rest, not encrypted in transit

API keys are AES-GCM encrypted in IndexedDB (the `pie` database). For BYOK
instances they are sent in plaintext as the `Authorization` header on direct
HTTPS calls to the provider — no Pie-side proxy, so there is no in-transit
exposure beyond what the provider itself sees. (The optional managed
subscription is the exception: those requests are forwarded through Pie's
gateway — see PRIVACY.md.) The encryption-at-rest threat model is "another
extension or a user with disk access cannot trivially recover the key from a
backup of the IndexedDB store."

### 4.2 Native tool calling, no JSON-mode workarounds

Anthropic `tool_use` and OpenAI `function_calling` are first-class in the
agent loop. The model router never asks the LLM to "respond with JSON" —
that pattern is brittle (LLMs return prose mixed with code fences,
malformed JSON, hallucinated tool names) and is incompatible with
streaming. Every supported provider exposes tool calling; if a future
provider does not, it should not be supported until they do.

### 4.3 Untrusted content lives in user-role messages, never in system

The system prompt is constructed from in-bundle constants only —
capability inventory, safety rails, role description. Anything that comes
from the page, the user (free-form), or a skill's rendered template
becomes a wrapped `<untrusted_X>` block inside a user-role message. The
LLM is instructed once in system prompt that wrappers are data, not
instructions; the wrapper-escape regex (§3.3) keeps the data from
breaking out.

### 4.4 Risk-gated mutations with informed consent

Every tool call that is irreversible (form submit, close pinned tab,
cross-origin tab op, raw CDP input, skill creation) gates behind a
confirm card. The card shows the **raw** tool args (panel display
otherwise redacts sensitive arg patterns) so the user can spot a
prompt-injection-driven argument change before it runs. Three rejected
confirms in a single task auto-terminate the task to stop burning tokens
on a plan the user has already disagreed with.

### 4.5 Per-session sandbox + cross-session lock

Each session has its own port, its own pinned tabs, its own CDP
ownerToken, and its own agent IR. A second session cannot inspect or
mutate the first's state. Cross-session interference is bounded by the
R7 pinned-tab registry: if session A has tab 42 pinned in `task` or
`user` mode, session B's tool call to operate on tab 42 is rejected at
dispatch.

### 4.6 Wire-format strings, IR blocks

`ChatMessage.content` (panel ↔ SW wire format) is always `string`. The
`AgentMessage.content` (SW-internal IR) is `string | ContentBlock[]` and
holds image / tool_use / tool_result blocks. The boundary is
`chatMessagesToAgent()` in `model-router/index.ts`. This separation lets
the wire schema stay backward-compatible while the IR evolves.

---

## §5 End-to-End Data Flow

A representative trace of a single agent task:

```
   USER types "summarize this article"  +  Send
        │
        ▼
1. Side Panel — Composer
        │  - Validates non-empty
        │  - Connects (or reuses) port `chat-stream-${sessionId}`
        │  - Posts ChatStartMessage { sessionId, userInput, attachments? }
        ▼
2. Service Worker — Message router
        │  - Reads SessionMeta to confirm no in-flight task
        │  - Resolves active ModelConfig (instance → decrypt apiKey)
        │  - Snapshots ModelConfig into the task's checkpoint (C1 invariant)
        │  - Captures pinnedTabs[0] from the active tab if pinMode='task'
        │  - Spawns runAgentLoop(taskInput, ctx)
        ▼
3. Agent Loop — iteration 0
        │  3a. executeScript(extractPageContentHardened, [focusTabId])
        │      → PageSnapshot { elements, metadata, … }
        │  3b. Wrap snapshot in <untrusted_page_content>…</untrusted_page_content>
        │      Build messages = [system, user(task + wrapped snapshot)]
        │  3c. Apply window.ts truncation (tokenBudget = ModelMeta.maxContextTokens - reserve)
        │  3d. for event in streamChat(modelConfig, truncated, signal, tools):
        │         port.postMessage(event)               # → side panel renders
        │         if event is tool_use: collect
        ▼
4. LLM Provider (e.g. Anthropic)
        │  HTTPS direct, Authorization: Bearer <decrypted apiKey>
        │  Streams text-delta + tool_use blocks
        │  ← back to 3d
        ▼
5. Agent Loop — post-LLM
        │  if no tool_use:
        │    finalize assistant text; emit done; tombstone agentMessages
        │  if tool_use(s):
        │    for each:
        │      assessment = classifyRisk(name, args, snapshot, ctx)
        │      if assessment.level === 'high':
        │        port.postMessage(SessionConfirmRequestMessage { confirmationId, raw args, tabTargets })
        │        await user-resolution                  ← Side Panel renders confirm card
        │      result = await dispatch(toolUse, ctx)    ← may executeScript / chrome.tabs / chrome.debugger
        │      append tool_use + tool_result to agentMessages
        │    persist SessionAgentState, SessionMeta.messages
        │    step++; goto iteration step
        ▼
6. Task end (success / fail / abort / max-steps)
        │  - emitDone (synthesize a summary turn into SessionAgentState.lastTaskSynth)
        │  - tombstone SessionAgentState (agentMessages: [], stepIndex: 0)
        │  - panel re-renders SessionMeta.messages with the synthesized turn
```

Two implicit checkpoints worth calling out:

- **Step 2's ModelConfig snapshot**. After the SW has captured the
  resolved config, instance changes mid-task are ignored. The user
  cannot accidentally swap providers mid-loop.
- **Step 5's persistence**. `SessionAgentState` is written every step;
  on SW restart, `session-recovery.ts` reads `stepIndex > 0` and
  transitions to `paused` (or `failed` if `hasImageContent`). The user
  sees a "Resume task" affordance in the panel.

For multimodal (image-bearing) tasks the flow is the same; the wrinkle
is that image bytes never touch storage — `SessionAgentState` carries
`{ kind: 'image_placeholder' }` markers and the SW's `image-cache.ts`
holds the bytes only for the duration of the task. See
[`docs/solutions/2026-05-04-multimodal-image-input-v1.md`](./solutions/2026-05-04-multimodal-image-input-v1.md).

---

## §6 Storage Model

All persistence lives in **IndexedDB** — a single database named `pie`
(`src/lib/idb/db.ts`, schema version 3) plus two sibling databases. There is
no remote storage and no cookies. The one-time migration off
`chrome.storage.local` (`startup-migrations.ts`) runs on startup and then
clears the old data; `crypto.ts` keeps a fallback read of the legacy
encryption key during that window.

### 6.1 Object stores

The `pie` database has six object stores:

| Store | Key | Holds |
|---|---|---|
| `sessions` | `id` | One record each for `${sid}:meta` (display state), `${sid}:agent` (LLM IR), and `${sid}:archived` (frozen archive payload) |
| `session_index` | `id` | Lightweight summary list for the SessionDrawer (avoids a full scan) |
| `instances` | `id` | Per-instance provider config; the `apiKey` field is AES-GCM encrypted |
| `config` | `key` | Misc single-value keys: encryption key, `active_instance_id`, `last_model_selection`, `pcm_*` / `pcmm_*` custom-model pools, `enabled_skills`, theme, custom-provider defs, migration traces |
| `scratchpads` | `id` | Per-session long-horizon scratchpad records |
| `schedules` | `id` | Scheduled-task definitions |

Two sibling databases keep heavier blobs out of the main one:

- **`pie-skills`** (store `packages`) — user- and agent-authored SkillPackage definitions.
- **`pie-output-files`** (store `artifacts`) — files the agent produces, indexed by session for the download cards.

### 6.2 What is intentionally **not** stored

- **Image bytes**. `SessionAgentState.agentMessages` carries `image_placeholder`
  blocks; the `image-cache.ts` SW-resident map holds bytes only for the
  current task. Storage write paths (`setSessionMeta`,
  `setSessionAgentState`) substitute placeholders before write.
- **CDP attach state**. `chrome.debugger.attach` is a runtime fact, not a
  persisted one. SW restart triggers detach (Chrome auto-detaches when
  the listener disappears), and re-attach is explicit on the next call.
- **Pending panel-request resolvers**. The `Promise` resolver for a HITL
  panel-request lives in SW memory; the persisted field is metadata for UI
  re-render, not a resolver reference. SW restart clears it from every session
  before any other recovery work.
- **Long-lived OAuth / refresh tokens**. The optional managed subscription
  signs in via a one-shot OAuth flow and keeps only the resulting long-lived
  virtual key — stored as an encrypted instance key (above), with no
  refresh-token loop.

### 6.3 Atomicity and change notification

Cross-store writes go through a `txMulti` helper (`src/lib/idb/db.ts`) that
commits every affected store in a single IndexedDB transaction — e.g. a
session record plus its `session_index` row, or an archive (delete the live
record + write the archived one) committed together so a crash mid-operation
can't leave a half-written session. Cross-context change notifications use a
`store-bus` (`BroadcastChannel('pie-store')`), which replaced the old
`chrome.storage.local.onChanged` listener.

---

## §7 Further Reading

| Where | What you find there |
|---|---|
| [`README.md`](../README.md) | User-facing positioning, feature list, install instructions |
| [`CLAUDE.md`](../CLAUDE.md) | Compact architecture snapshot + invariants for AI-assisted contributors |
| [`docs/ROADMAP.md`](./ROADMAP.md) | Delivered phases and deferred backlog (single source of truth) |
| [`docs/solutions/`](./solutions/) | Per-phase / per-milestone invariant trace docs — the receipts behind every load-bearing constraint mentioned above |
| [`docs/solutions/security-issues/`](./solutions/security-issues/) | Threat catalogs and per-family test coverage (wrapper-tag escape, CDP debugger lifecycle, etc.) |
| [`PRIVACY.md`](../PRIVACY.md) | Privacy policy — what leaves the device, what does not |
| [`docs/release-notes/`](./release-notes/) | Per-version user-visible changelog |

If you are touching a load-bearing module, search `docs/solutions/` for the
relevant phase or milestone before changing the contract — many of the
invariants summarized here have a paragraph or two of context (and a
tragic story) behind them.
