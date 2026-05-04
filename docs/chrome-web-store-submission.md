# Chrome Web Store — Submission Copy

Copy-paste source for the CWS Developer Dashboard submission of `pie-0.5.0.zip`. Each section below corresponds to one field in the CWS form.

---

## Single purpose description

> Pie is an AI assistant in a browser side panel that uses **your own API key** to read the current page on demand and, with your confirmation for any sensitive action, automate multi-step browsing tasks across your tabs.

---

## Permission: `debugger`

> Pie uses the `debugger` permission for **one purpose only**: to simulate keyboard input via the Chrome DevTools Protocol method `Input.dispatchKeyEvent` / `Input.insertText` inside canvas-based rich-text editors (e.g. Lark Docs, Google Docs) where standard DOM `input` events are not honored. This is the only CDP domain Pie attaches to (`Input`); it never inspects, records, or modifies network traffic, console output, storage, or other extensions.
>
> This feature is **disabled by default**. The user must explicitly enable a "CDP keyboard simulation" toggle in Settings before any `chrome.debugger.attach` call is made.
>
> Safety mechanisms in place:
> - Per-task lazy attach scoped to one tab; the standard "Pie started debugging this browser" infobar is shown to the user.
> - Detach is idempotent across 5 paths (explicit, abort signal, `onDetach`, kill-switch, finally) so no orphaned debugger session can persist.
> - An owner-token guard prevents one Pie side-panel instance from detaching another's session.
> - Every CDP call re-verifies the active tab and origin to prevent accidental input on an unrelated tab.
> - All keystrokes triggered via this path are classified as **high-risk** and require the user to approve a confirmation card before execution.

---

## Permission: `<all_urls>` (host permission)

> Pie's side panel is a persistent UI. The user can, at any moment, ask "summarize this page" or "do X on this page" while looking at any website they have chosen to visit. Pie cannot enumerate ahead of time which sites the user will want to use it on.
>
> Page reads happen **only** in response to an explicit user request (chat message or skill invocation). Pie does not read pages in the background, does not crawl, does not observe page navigation events, and does not register any `webNavigation` or `webRequest` listeners. The page content is sent only to the LLM provider the user has configured with their own API key.
>
> The host permissions list also enumerates the six supported LLM provider API endpoints (Anthropic, OpenAI, OpenRouter, MiniMax, ZhiPu, Bailian) so that requests can be made from the service worker.

---

## Permission: `scripting`

> Pie uses `chrome.scripting.executeScript` to inject self-contained DOM-action functions into the page when the user invokes an agent task that requires reading or interacting with the DOM (e.g. "click the Submit button", "extract the article text"). All injected functions are bundled with the extension; **no remote code is fetched or executed**.
>
> Each injected function is a single pure function defined inside `src/lib/dom-actions/`, called via `executeScript` with explicit arguments — there are no closures, no `eval`, and no string-to-function conversion. The injection target is always the user-pinned tab for the active task.

---

## Permission: `tabs`

> Pie offers user-invokable cross-tab tools (`list_tabs`, `activate_tab`, `close_tabs`, `get_tab_content`, `move_tabs`) that power skills like "close duplicate tabs" or "summarize my open tabs." These tools require reading basic tab metadata (id, title, URL, pinned/active flags) and switching the active tab.
>
> Tab metadata is exposed to the LLM only as part of an explicit user task and is wrapped in `<untrusted_tab_metadata>` markers in the prompt to defeat prompt-injection attempts via tab titles. Cross-origin tab operations are classified as **high-risk** and require the user to approve a confirmation card listing each affected tab's origin and title before any action runs.

---

## Permission: `tabGroups`

> Pie includes a built-in skill `auto_group_tabs` that uses `chrome.tabGroups.update` and `chrome.tabs.group` to organize the user's tabs into themed groups (e.g. by domain or topic) at the user's request. This permission is used **only** as part of that explicit user-invoked skill; Pie never modifies tab groups in the background.
>
> Group titles are sanitized (control characters stripped, untrusted-content wrappers escaped) before being applied, to prevent prompt-injected group names from confusing later agent reasoning.

---

## Other permissions (low-scrutiny, included for completeness)

- **`activeTab`** — Used for the user gesture path (clicking the extension's action icon to open the side panel). Note: this is partially redundant with `<all_urls>` and is being evaluated for removal in a future version.
- **`sidePanel`** — Required to render Pie's UI in Chrome's side panel surface.
- **`storage`** — Used to persist sessions, encrypted API keys, and preferences in `chrome.storage.local`. No data is synced across devices; `chrome.storage.sync` is not requested.

---

## Remote code use

> **Pie does NOT use remote code.** All JavaScript that runs in the extension (service worker, side panel, and `chrome.scripting.executeScript` injections) is bundled into the extension package at build time. The extension makes outbound network requests **only** to the LLM provider API endpoints declared in `host_permissions`, and only with the request bodies the user generated by chatting or invoking a skill. No code is fetched, evaluated, or imported at runtime from any remote source.

---

## Data usage disclosures (Privacy Practices form — what to check)

Tick **only** the categories that apply, in line with `PRIVACY.md`:

- ☑ **Authentication information** — the user's LLM API key, stored encrypted on-device, transmitted only to the matching provider.
- ☑ **User activity** — chat messages, page snippets, and tool-call results are sent to the LLM provider the user configured. *Not* sent to any developer-operated server (there is none).
- ☑ **Website content** — page text and DOM snapshots are read on demand and forwarded to the user's chosen LLM provider as part of an explicit task.
- ☐ Personally identifiable information — not collected.
- ☐ Health information — not collected.
- ☐ Financial / payment information — not collected.
- ☐ Personal communications — not collected. (Chat with the LLM is conducted by the user with their own provider account; Pie is the transport.)
- ☐ Location — not collected.
- ☐ Web history — not collected.

**Certifications to confirm:**

- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Listing description (suggested)

**Short description (≤132 chars):**

> Bring your own LLM API key. Pie reads, summarizes, and automates pages in a side panel — local keys, no servers, full consent.

**Detailed description draft:**

> **Pie** is a Chrome extension that brings AI assistance into a side panel — using **your own API key**, with no developer-operated server in between.
>
> **Bring Your Own Key.** Pie supports Anthropic, OpenAI, OpenRouter, MiniMax, ZhiPu, and Bailian. You paste your key once; it's encrypted on-device with AES-GCM and sent only to the matching provider.
>
> **What Pie can do:**
> - Chat with awareness of the current page.
> - Run multi-step agent tasks: read the DOM, click elements, fill forms, scroll, switch tabs.
> - Manage your tabs: group by topic, close duplicates, summarize all open tabs.
> - Run user-defined "skills" — saved prompt templates with scoped tool access.
>
> **Safety, by design:**
> - Every high-risk action (form submission, sensitive-field input, closing pinned tabs, cross-origin tab operations, CDP keyboard input) requires you to approve a confirmation card before it runs.
> - The CDP keyboard-simulation feature for canvas editors (Lark Docs, Google Docs) is **off by default** and must be explicitly enabled in Settings.
> - No telemetry, no analytics, no tracking. The developer of Pie operates **no servers**.
>
> Privacy policy: https://github.com/WiseriaAI/Pie/blob/main/PRIVACY.md
> Source code: https://github.com/WiseriaAI/Pie

---

## Pre-submission checklist

- [ ] Verify the publisher email and complete trader / non-trader self-declaration in the dashboard.
- [ ] Upload `pie-0.5.0.zip` (179 KB).
- [ ] Paste single-purpose description, all permission justifications, and remote-code = NO.
- [ ] Tick Privacy Practices boxes per the table above.
- [ ] Link `PRIVACY.md` raw URL as the privacy policy URL.
- [ ] Upload 3–5 screenshots at 1280×800 (recommended set: side panel chat, agent task with confirm card, settings with CDP toggle off, skills list, tab-group result).
- [ ] Pick category `Productivity` and primary language `English` + secondary `Chinese (Simplified)`.
- [ ] Set distribution `Public` (or `Unlisted` for a soft launch).
- [ ] Submit for review. Expect 5–14 days given the `debugger` + `<all_urls>` + agent-style description combination.
