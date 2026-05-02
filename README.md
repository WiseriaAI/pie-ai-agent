# Chrome AI Agent

> BYOK browser AI — bring your own API key for page understanding, agent automation, and smart tab management.

A Chrome Extension that gives you full AI browser capabilities using your existing API keys (Claude, GPT, Gemini, or local Ollama). No extra subscriptions needed.

## Features

- **Page Understanding** — analyze page content, extract data, answer questions
- **Agent Automation** — describe tasks in natural language, AI breaks them into steps and executes
- **Smart Tab Management** — agent tools (`list_tabs` / `close_tabs` / `group_tabs` / `activate_tab` / `get_tab_content` / etc.) plus three built-in skills (auto_group_tabs / close_duplicate_tabs / close_inactive_tabs); write your own via the SkillsList editor for anything else

## v0.4.0 release notes

- 7 new cross-tab agent tools and 3 built-in tab skills
- Adds the `tabGroups` Chrome permission — the browser will ask you to re-authorize the extension after updating
- Service Worker restart on update terminates any in-flight task (Chrome platform behavior; no extra clean-up logic needed)
- Hardens the `<untrusted_skill_params>` wrapper used by Phase 2.6 self-authored skills against agent-supplied wrapper-tag literals (closes the `renderTemplate` wrapper-escape vector reported by adversarial review)

## Setup

```bash
pnpm install
pnpm dev
```

Load the extension from `dist/` in `chrome://extensions` (Developer mode).

## License

MIT
