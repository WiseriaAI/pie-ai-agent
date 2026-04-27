# Chrome AI Agent

BYOK (Bring Your Own Key) Chrome Extension — 用户插入自己的 API key 获得 AI 浏览器能力。

## Tech Stack

- Chrome Extension Manifest V3
- React 19 + TypeScript 6
- TailwindCSS v4 (Vite plugin, no config file)
- Vite 8 + @crxjs/vite-plugin 2.4
- pnpm

## Project Structure

- `src/background/` — Service Worker: message routing, port streaming, agent loop dispatch, keep-alive
- `src/content/` — Content Script: placeholder (DOM ops use executeScript injection instead)
- `src/sidepanel/` — Sidebar UI (React): Chat (with Agent UI), Settings (with Skills), tab navigation
- `src/sidepanel/components/` — Chat.tsx, Settings.tsx, AgentStepBubble/AgentConfirmCard/AgentSummary, SkillsList
- `src/lib/model-router/` — Unified LLM interface with tool calling support (AgentMessage IR)
- `src/lib/model-router/providers/` — Anthropic (native tool_use), OpenAI-compatible (function_calling)
- `src/lib/model-router/providers/registry.ts` — Provider metadata registry (supportsTools field)
- `src/lib/dom-actions/` — Self-contained DOM action functions injected via executeScript
- `src/lib/agent/` — ReAct loop, tool registry, risk classifier, prompt builder, sliding window
- `src/lib/skills/` — Skill framework: types, storage, builtin, resolveSkillToTools
- `src/lib/crypto.ts` — AES-GCM encryption for API key storage
- `src/lib/storage.ts` — Provider config CRUD (encrypted keys in chrome.storage.local)
- `src/types/` — Shared type definitions and message types (chat + agent protocols)

## Supported Providers

Anthropic (native API), OpenAI, OpenRouter, MiniMax, ZhiPu (智谱), Bailian (百炼).
All OpenAI-compatible providers share one streaming implementation via registry.

## Commands

- `pnpm dev` — Start dev server with HMR
- `pnpm build` — Build for production
- `pnpm preview` — Preview production build

## Development

1. `pnpm dev` starts the Vite dev server
2. Go to `chrome://extensions`, enable Developer mode
3. Load unpacked from `dist/` directory
4. Click extension icon to open side panel

## Architecture Notes

- API keys encrypted with Web Crypto API (AES-GCM) in chrome.storage.local, encryption key also in chrome.storage.local
- DOM access via `<all_urls>` host_permission + `chrome.scripting.executeScript` (activeTab insufficient for Side Panel常驻场景)
- Streaming via `chrome.runtime.connect()` port, not sendMessage (supports continuous push)
- Keep-alive pattern: `chrome.runtime.getPlatformInfo()` every 25s during active port connections
- SSE parser handles both `\n` and `\r\n` line endings
- Provider registry pattern: new providers only need a registry entry + host_permission + supportsTools flag
- All injected functions (extractPageContent, snapshotInteractiveElements, click/type/scroll/select) must be self-contained (no closures, args via executeScript)
- ChatMessage stays string-only (Phase 1 wire); AgentMessage IR (string | ContentBlock[]) is SW-internal only
- Agent Loop: tabId+origin pinning at task start, every-round origin check (security)
- Risk classifier: default low + structural escalation (submit buttons, sensitive fields, keyword regex)
- Prompt injection defense: page snapshots in user role wrapped in <untrusted_page_content>, never in system role

## Progress

- **Phase 1 (基础对话) — COMPLETED**: Chat with page context, streaming, API key management, 6 providers
- **Phase 0 (元素定位验证) — COMPLETED**: DOM traversal validated, region filtering works, `<all_urls>` permission needed
- **Phase 2 (Agent 能力) — COMPLETED**: ReAct Agent Loop with tool calling, DOM operations, risk-based confirmation, basic Skill framework
- **Phase 2.5 (CDP 键盘模拟) — PLANNED**: 通过 `chrome.debugger` + `Input.insertText` 支持 canvas 编辑器（飞书 Docs / Google Docs / Notion）。见 `docs/brainstorms/2026-04-17-phase2.5-cdp-keyboard-simulation-requirements.md`
- **Phase 3 (标签管理) — NOT STARTED**: Tab analysis, grouping, cleanup
