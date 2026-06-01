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
- `src/lib/model-router/` — Unified LLM interface + tool calling; per-provider modules under `providers/` + two shared cores (`_shared/openai-compat-core.ts`, `_shared/anthropic-sdk-core.ts` 官方 `@anthropic-ai/sdk` 后端) + `registry.ts` 元数据 + id-keyed `providers/index.ts` dispatch（provider 清单见 README）
- `src/lib/dom-actions/` — Self-contained DOM action functions injected via executeScript
- `src/lib/agent/` — ReAct loop, tool registry, prompt builder, sliding window, `untrusted-wrappers.ts`, `tool-names.ts`(read/write tool 分类)
- `src/lib/agent/tools/` — `keyboard.ts` (CDP) / `skill-meta.ts` (skill CRUD) / `tabs.ts` (cross-tab) / `pdf.ts` (`read_pdf` / `search_pdf` / `get_pdf_outline` tools, all read-class)
- `src/lib/pdf/` — PDF tab detection (`isPdfTab`) + page-range parser (`parsePageRange`)
- `src/offscreen/` — Offscreen document hosting LiteParse v2 WASM (`pdf-parser.html` + `pdf-parser.ts`), in-memory cache, message dispatch
- `src/background/offscreen-manager.ts` — Lazy offscreen lifecycle + SW↔offscreen request/response bridge
- `src/lib/skills/` — Skill framework: SkillPackage (frontmatter + virtual file tree) stored in IndexedDB (skill-store), SKILL.md frontmatter parser, builtin packages, getEnabledSkillPackages; skills are accessed via use_skill/read_skill_file mediation tools + a system-prompt catalog and are NOT tools themselves.
- `src/lib/sessions/` — Multi-session persistence: state-machine, lifecycle (archive/delete), pinned-tab-registry, title
- `src/lib/crypto.ts` — AES-GCM encryption helper（与 `src/lib/instances.ts` 配合存 instance API key）
- `src/lib/instances.ts` — Multi-instance CRUD; `instance_${uuid}` + `instances_index` + `active_instance_id`
- `src/lib/migration-v2.ts` — V1→V2 silent migration (`provider_*` → `instance_*`)
- `src/lib/provider-custom-models.ts` — per-provider sticky pool（`pcm_${provider}`）跨 instance 共享自定义 model id
- `src/lib/openrouter-models-fetch.ts` — `/v1/models` 公共 endpoint normaliser
- `src/types/` — Shared message + agent protocol types

## Commands

- `pnpm dev` — Dev server with HMR
- `pnpm build` — Production build
- `pnpm test` / `pnpm test:watch` — vitest run
- `pnpm typecheck` — `tsc --noEmit`（repo-wide 现已 0 错；任何新报错都是真实回归，必须修，别再当噪音忽略）
- 提交前跑 `pnpm test`、`pnpm typecheck` 与 `pnpm build`（build-time invariants 在 `tool-names.ts`（每个 tool 必须声明 read/write class）/ `tools.ts`（R-iframe-1 write tool 必须 require frameId）会 throw）。注：`tsc` 能跑是靠 tsconfig 的 `ignoreDeprecations: "6.0"`（跨过 `baseUrl` TS5101 硬错）+ `src/global.d.ts` 引用 `chrome`/`vite/client` 类型；移除任一都会让 tsc 退回"哑门禁"
- 远端 GH 操作前先 `gh auth switch --user WiseriaAI`；默认 active 账号 `wenkang-xie` 在 org 仓库无 admin scope（Pages API / repo settings 会 404）

## Development

1. `pnpm dev` 启 Vite dev server
2. `chrome://extensions` 开启 Developer mode
3. Load unpacked 加载 `dist/` 目录
4. 点击扩展图标打开 side panel

## Release

`.github/workflows/release.yml` 是唯一发布入口。**不要**手动 `gh release upload` 传 zip——除非是已发布 tag 的紧急补救。

发新版流程：
1. bump `package.json` 和 `manifest.json` 的 `version`（必须一致），commit
2. `git tag v0.x.y && git push origin v0.x.y`
3. 在 GitHub 上 publish release notes（tag 已存在即可）
4. tag push 触发 workflow → CI 跑 `pnpm build` → 验 manifest invariant → 打包 `pie-0.x.y.zip` → 上传到对应 release

Workflow 内置 invariant（任一失败则 CI fail，不会上传）：
- `dist/manifest.json` 的 `background.service_worker` 和 `content_scripts[0].js[0]` 必须以 `.js` 结尾（不是 `.ts`）
- `manifest.version` 必须等于 tag 去掉 `v` 前缀（即 package.json / manifest.json 没 bump 就发 tag 会被拦下）

补传历史 tag：`gh workflow run release.yml -f tag=v0.x.y`（用 `workflow_dispatch`，会 checkout 那个 tag commit 重 build + `--clobber` 覆盖）。

为什么严格：README Option 2 引导用户从 release 下载 `pie-x.y.z.zip` 解压加载；release 没有 asset → 用户只能下 GitHub 自动生成的 Source code (zip)，源码 manifest 引用 `src/**/*.ts` → Chrome 拒（Service worker registration failed / Invalid script mime type）。

## Architecture Invariants (evergreen)

> Phase 落地的具体 invariant 清单（P3-A...V / M3-U1...U5 / capability-grant guards 等）见 `docs/solutions/`，不在此重复。

- API keys: Web Crypto AES-GCM 加密存 `chrome.storage.local`，加密密钥也在 local；instance 维度持久化（不再是旧的 `provider_${id}` 单档）
- DOM access: `<all_urls>` host_permission + `chrome.scripting.executeScript`（activeTab 不够 side-panel 常驻场景）
- Streaming: `chrome.runtime.connect()` port，**不用** `sendMessage`；keep-alive 25s `getPlatformInfo()`
- SSE parser 同时处理 `\n` 和 `\r\n` 行尾
- Provider registry pattern: 加 provider = registry entry + 模块文件 + manifest host_permission；capability flags (`vision`/`tools`/`maxContextTokens`) 在 `ModelMeta` per-model 维度；id-keyed dispatch 表 `streamChatByProvider`（builtin）或 `dispatchStreamChat`（custom）。Provider 模块基本是薄 wrapper：OpenAI-compat 家族（openai/openrouter/zhipu/bailian）走 `_shared/openai-compat-core.ts`（OpenRouter 用 customHeaders hook）；**所有 Anthropic-wire 家族（anthropic/deepseek/minimax/mimo）走 `_shared/anthropic-sdk-core.ts`** —— 官方 `@anthropic-ai/sdk` 后端（#91 起取代手写 SSE core），hooks: `baseUrlSuffix` / `auth(apiKey\|bearer)` / `stripAnthropicVersion` / `promptCache`。per-provider：anthropic = apiKey + promptCache；deepseek/minimax = baseUrlSuffix `/anthropic` + apiKey（minimax base `api.minimaxi.com`，M3 含图片输入）；mimo = baseUrlSuffix `/anthropic` + bearer + stripAnthropicVersion。Gemini 自带 native module。SDK 在 MV3 service worker 里已验证可用：无 eval（CSP-safe），用 fetch/ReadableStream，`process.*`/`Buffer` 引用全被 runtime 探测或鸭子类型 guard，缺失时不执行
- Custom provider `baseUrl` 在 provider 层定义（`StoredCustomProvider.baseUrl`），instance 不能 override
- Custom provider 一律走 `_shared/openai-compat-core.ts`（OpenAI-compat wire，不带 hooks）
- `<all_urls>` host_permission 是 custom provider fetch（`/v1/models` + streaming）的前提
- Multi-instance config: 同 provider × N instance 独立 nickname/model/apiKey；global `active_instance_id` + per-session `instanceId` override；task start 时 SW snapshot ModelConfig 进 checkpoint，中途改 active 不影响 in-flight loop
- BaseURL 封装: `defaultBaseUrl` 唯一权威，UI 不暴露；老用户手填 baseUrl 在 V1→V2 migration 中静默丢弃
- Injected functions 必须 self-contained（无闭包，args 通过 `executeScript`）
- ChatMessage 始终 string-only（wire format）；AgentMessage IR (`string | ContentBlock[]`) 仅 SW 内部
- Agent Loop: tabId+origin pinning at task start，每轮 origin 重检——但**重检是咨询式（advisory），不再硬停**。origin 漂移 / restricted / tab 关闭 / 仍在导航，统统由 `interpretPinnedTabUrl` 返回 `notice`，loop 把它注入成 trusted `<system_notice>` observation（warn-once，按 `noticeKey` 去重），交给 LLM 自行决定继续 / 恢复 / 调 `fail`。**终止只由 LLM（`done`/`fail`/纯文本）或用户 abort 触发**：loop 无界（无 MAX_STEPS 硬上限，过 `SOFT_STEP_BUDGET` 只升级软提示），反复循环检测只升级 reflection note 不再 give-up（旧的 `generateStuckSummary` / `REFLECTION_GIVEUP_RESULT` / "Max steps reached" 路径已移除）。`<system_notice>` 是 trusted runtime 块（同 `<reflections>`），不是 `<untrusted_*>`。
- Tool 执行: 无 confirm 层，tool call 直接执行（旧的 risk classifier / `risk.ts` / `sendConfirmRequest` 已移除，见 `src/__tests__/cross-layer/no-confirm-*.test.ts`）；`tool-names.ts` 仅保留 read/write 分类，供 R7 跨 session 锁判定 write-class tool
- Prompt injection 防御: 页面 snapshot 在 user role 用 `<untrusted_*>` wrapper（`untrusted_page_content` / `untrusted_tab_metadata` / `untrusted_user_message`），**never** 进 system role；`untrusted-wrappers.ts` 是唯一 escape 入口
- Per-session sandbox: per-session port (`chat-stream-${sessionId}`) + per-session `pinnedTabs[]` + `currentFocusTabId` (v1.5 multi-pin) + CDP `ownerToken={sessionId,tabId}` + 跨 session R7 lock
- Session 持久化: storage at-rest 持 raw `agentMessages`（LLM resume 需要原始 context），panel render 才走 `redactArgsForPanel`；archive/restore 走 `writeAtomic` 单调用
- PDF capability: Chrome's built-in PDF viewer is sealed, so PDF text is parsed via an MV3 offscreen document running LiteParse v2 WASM (~4 MB, Apache-2.0). The `offscreen` permission + `wasm-unsafe-eval` CSP in `extension_pages` are required. WASM is copied from `node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm_bg.wasm` into `public/liteparse.wasm` at build time (gitignored) and emitted to `dist/liteparse.wasm`. The three PDF tools (`read_pdf` / `search_pdf` / `get_pdf_outline`) route through `src/background/offscreen-manager.ts` which uses `chrome.runtime.sendMessage({target:"offscreen",...})` for request/response. Cache is in-memory in the offscreen doc, keyed by `tab.url`; SW idle → offscreen evicted → re-parse next call. `read_page` returns a `pdf_tab:` error on PDF tabs so the LLM self-corrects to `read_pdf`. New untrusted wrappers `untrusted_pdf_page` / `untrusted_pdf_match` / `untrusted_pdf_outline_entry` are registered in both `UNTRUSTED_WRAPPER_TAGS` (untrusted-wrappers.ts) and `WRAPPER_TAGS_LIST` (page-snapshot.ts) per dual-list invariant. Local PDFs require the user to enable `Allow access to file URLs`; `<PdfPermissionCard>` mounts via `usePdfPermission` when the SW broadcasts `pdf:needs-file-access`.

## Docs Map

- `docs/ROADMAP.md` — 已交付 phases + backlog（single source of truth）
- `docs/solutions/` — 落地后的 invariant trace docs（per phase / per milestone）
- `docs/specs/` — superpowers `brainstorming` skill 产出（design / requirements / spec），含 Phase 1–3 历史 brainstorm 合并归档
- `docs/plans/` — superpowers `planning` skill 产出（实施 plan），含 Phase 1–3 历史 plan 合并归档
- `docs/release-notes/` — 用户可见 changelog
- `docs/design.md` — 早期 Phase 0–3 设计构想（历史档案）
- `docs/archive/index.html` — 项目档案知识库（单文件，vanilla JS / 零依赖）；编辑 `archiveData` 数组 → push 到 main → `.github/workflows/deploy-archive-pages.yml` 自动部署到 https://wiseriaai.github.io/pie-ai-agent/ ；Pages source = GitHub Actions，仅上传 `docs/archive/`，其他 docs/ 不进 Pages

### Convention：superpowers brainstorm / plan 输出位置

- `brainstorming` skill 产出（design doc / requirements / spec）→ `docs/specs/<YYYY-MM-DD>-<slug>.md`
- `planning` skill 产出（实施 plan）→ `docs/plans/<YYYY-MM-DD>-<slug>.md`
- 不再使用 `docs/superpowers/` 子目录或 `docs/brainstorms/`（已合并迁出）
- 历史与新产出在同一目录共存；按文件名日期前缀排序即可区分新旧
