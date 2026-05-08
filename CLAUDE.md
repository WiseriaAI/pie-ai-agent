# Chrome AI Agent (Pie)

BYOK (Bring Your Own Key) Chrome Extension — 用户插入自己的 API key 获得 AI 浏览器能力。

## Tech Stack

- Chrome Extension Manifest V3, React 19 + TypeScript 6
- TailwindCSS v4 (Vite plugin, no config file), Vite 8 + @crxjs/vite-plugin 2.4
- pnpm; vitest + happy-dom + @testing-library/react

## Project Structure

- `src/background/` — Service Worker: message routing, port streaming, agent loop dispatch, keep-alive, CDP session lifecycle
- `src/content/` — placeholder (DOM ops 走 `chrome.scripting.executeScript` 注入)
- `src/sidepanel/` — Sidebar UI: Chat (Agent UI) / Settings / SkillsList / SessionDrawer
- `src/lib/model-router/` — Unified LLM interface + tool calling; `providers/` 8 providers + `_shared/openai-compat-core.ts` + `registry.ts` 元数据 + id-keyed `providers/index.ts` dispatch
- `src/lib/dom-actions/` — Self-contained DOM action functions injected via executeScript
- `src/lib/agent/` — ReAct loop, tool registry, risk classifier, prompt builder, sliding window, `untrusted-wrappers.ts`, `tool-names.ts`
- `src/lib/agent/tools/` — `keyboard.ts` (CDP) / `skill-meta.ts` (skill CRUD) / `tabs.ts` (cross-tab)
- `src/lib/skills/` — Skill framework: types, storage, builtin, resolveSkillToTools
- `src/lib/sessions/` — Multi-session persistence: state-machine, lifecycle (archive/delete), pinned-tab-registry, title
- `src/lib/crypto.ts` — AES-GCM encryption helper（与 `src/lib/instances.ts` 配合存 instance API key）
- `src/lib/instances.ts` — Multi-instance CRUD; `instance_${uuid}` + `instances_index` + `active_instance_id`
- `src/lib/migration-v2.ts` — V1→V2 silent migration (`provider_*` → `instance_*`)
- `src/lib/provider-custom-models.ts` — per-provider sticky pool（`pcm_${provider}`）跨 instance 共享自定义 model id
- `src/lib/openrouter-models-fetch.ts` — `/v1/models` 公共 endpoint normaliser
- `src/types/` — Shared message + agent protocol types

## Supported Providers

Anthropic (native), OpenAI, OpenRouter, MiniMax, ZhiPu (智谱), Bailian (百炼), Gemini (native), DeepSeek。
5 家 OpenAI-compat 走 `_shared/openai-compat-core.ts` (OpenRouter 加自家 headers via hooks)；Anthropic 和 Gemini 走自家 native module。新加 provider = registry entry + 模块文件 + manifest host_permission，不改 dispatch 代码。

## Commands

- `pnpm dev` — Dev server with HMR
- `pnpm build` — Production build
- `pnpm test` / `pnpm test:watch` — vitest run
- 提交前跑 `pnpm test` 与 `pnpm build`（build-time invariants 在 `risk.ts` / `tool-names.ts` 会 throw）

## Development

1. `pnpm dev` 启 Vite dev server
2. `chrome://extensions` 开启 Developer mode
3. Load unpacked 加载 `dist/` 目录
4. 点击扩展图标打开 side panel

## Architecture Invariants (evergreen)

> Phase 落地的具体 invariant 清单（P3-A...V / M3-U1...U5 / capability-grant guards 等）见 `docs/solutions/`，不在此重复。

- API keys: Web Crypto AES-GCM 加密存 `chrome.storage.local`，加密密钥也在 local；instance 维度持久化（不再是旧的 `provider_${id}` 单档）
- DOM access: `<all_urls>` host_permission + `chrome.scripting.executeScript`（activeTab 不够 side-panel 常驻场景）
- Streaming: `chrome.runtime.connect()` port，**不用** `sendMessage`；keep-alive 25s `getPlatformInfo()`
- SSE parser 同时处理 `\n` 和 `\r\n` 行尾
- Provider registry pattern: 加 provider = registry entry + 模块文件 + manifest host_permission；capability flags (`vision`/`tools`/`maxContextTokens`) 在 `ModelMeta` per-model 维度；id-keyed dispatch 表 `streamChatByProvider`（builtin）或 `dispatchStreamChat`（custom）
- Custom provider `baseUrl` 在 provider 层定义（`StoredCustomProvider.baseUrl`），instance 不能 override
- Custom provider 一律走 `_shared/openai-compat-core.ts`（OpenAI-compat wire，不带 hooks）
- `<all_urls>` host_permission 是 custom provider fetch（`/v1/models` + streaming）的前提
- Multi-instance config: 同 provider × N instance 独立 nickname/model/apiKey；global `active_instance_id` + per-session `instanceId` override；task start 时 SW snapshot ModelConfig 进 checkpoint，中途改 active 不影响 in-flight loop
- BaseURL 封装: `defaultBaseUrl` 唯一权威，UI 不暴露；老用户手填 baseUrl 在 V1→V2 migration 中静默丢弃
- Injected functions 必须 self-contained（无闭包，args 通过 `executeScript`）
- ChatMessage 始终 string-only（wire format）；AgentMessage IR (`string | ContentBlock[]`) 仅 SW 内部
- Agent Loop: tabId+origin pinning at task start，每轮 origin 重检
- Risk classifier: 默认 low + 结构化升级（submit / 敏感字段 / 关键字 / cross-origin args）；CDP keyboard tools 永远 high
- Prompt injection 防御: 页面 snapshot 在 user role 用 `<untrusted_*>` wrapper（`untrusted_page_content` / `untrusted_tab_metadata` / `untrusted_user_message`），**never** 进 system role；`untrusted-wrappers.ts` 是唯一 escape 入口
- Per-session sandbox: per-session port (`chat-stream-${sessionId}`) + per-session `pinnedTabs[]` + `currentFocusTabId` (v1.5 multi-pin) + CDP `ownerToken={sessionId,tabId}` + 跨 session R7 lock
- Session 持久化: storage at-rest 持 raw `agentMessages`（LLM resume 需要原始 context），panel render 才走 `redactArgsForPanel`；archive/restore 走 `writeAtomic` 单调用

## Docs Map

- `docs/ROADMAP.md` — 已交付 phases + backlog（single source of truth）
- `docs/solutions/` — 落地后的 invariant trace docs（per phase / per milestone）
- `docs/specs/` — superpowers `brainstorming` skill 产出（design / requirements / spec），含 Phase 1–3 历史 brainstorm 合并归档
- `docs/plans/` — superpowers `planning` skill 产出（实施 plan），含 Phase 1–3 历史 plan 合并归档
- `docs/release-notes/` — 用户可见 changelog
- `docs/design.md` — 早期 Phase 0–3 设计构想（历史档案）

### Convention：superpowers brainstorm / plan 输出位置

- `brainstorming` skill 产出（design doc / requirements / spec）→ `docs/specs/<YYYY-MM-DD>-<slug>.md`
- `planning` skill 产出（实施 plan）→ `docs/plans/<YYYY-MM-DD>-<slug>.md`
- 不再使用 `docs/superpowers/` 子目录或 `docs/brainstorms/`（已合并迁出）
- 历史与新产出在同一目录共存；按文件名日期前缀排序即可区分新旧
