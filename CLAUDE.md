# Chrome AI Agent

BYOK (Bring Your Own Key) Chrome Extension — 用户插入自己的 API key 获得 AI 浏览器能力。

## Tech Stack

- Chrome Extension Manifest V3
- React 19 + TypeScript 6
- TailwindCSS v4 (Vite plugin, no config file)
- Vite 8 + @crxjs/vite-plugin 2.4
- pnpm

## Project Structure

- `src/background/` — Service Worker: message routing, port streaming, page extraction, keep-alive
- `src/content/` — Content Script: placeholder for Phase 2 agent operations
- `src/sidepanel/` — Sidebar UI (React): Chat, Settings, tab navigation
- `src/sidepanel/components/` — Chat.tsx (streaming chat), Settings.tsx (provider config)
- `src/lib/model-router/` — Unified LLM interface with pluggable provider registry
- `src/lib/model-router/providers/` — Anthropic (native), OpenAI-compatible (shared by 5 providers)
- `src/lib/model-router/providers/registry.ts` — Provider metadata registry (add new providers here)
- `src/lib/crypto.ts` — AES-GCM encryption for API key storage
- `src/lib/storage.ts` — Provider config CRUD (encrypted keys in chrome.storage.local)
- `src/types/` — Shared type definitions and message types

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
- Content Script uses `activeTab` + dynamic injection via `chrome.scripting.executeScript` (no `<all_urls>`)
- Streaming via `chrome.runtime.connect()` port, not sendMessage (supports continuous push)
- Keep-alive pattern: `chrome.runtime.getPlatformInfo()` every 25s during active port connections
- SSE parser handles both `\n` and `\r\n` line endings
- Provider registry pattern: new providers only need a registry entry + host_permission
- `extractPageContent()` must be self-contained (no closures) for `executeScript` serialization

## Progress

- **Phase 1 (基础对话) — COMPLETED**: Chat with page context, streaming, API key management, 6 providers
- **Phase 0 (元素定位验证) — NOT STARTED**: Spike needed before Phase 2
- **Phase 2 (Agent 能力) — NOT STARTED**: Task planning, multi-step execution, DOM operations
- **Phase 3 (标签管理) — NOT STARTED**: Tab analysis, grouping, cleanup
