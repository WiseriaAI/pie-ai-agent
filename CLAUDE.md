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
- `src/offscreen/` — Offscreen document hosting LiteParse v2 WASM (`pdf-parser.html` + `pdf-parser.ts`), in-memory cache, message dispatch（#303 起 MV3 skill 脚本 sandbox iframe 已整体删除——磁盘 skill 脚本只走 daemon CLI，见 `src/lib/skills/`）
- `src/background/offscreen-manager.ts` — Lazy offscreen lifecycle + SW↔offscreen request/response bridge
- `src/lib/skills/` — Skill framework: SkillPackage (frontmatter + virtual file tree) stored in IndexedDB (skill-store), SKILL.md frontmatter parser, builtin packages, getEnabledSkillPackages; skills are accessed via use_skill/read_skill_file mediation tools + a system-prompt catalog and are NOT tools themselves. 磁盘 skill 可捆绑 `scripts/` 下的可执行脚本，经 `run_skill_script` **走 daemon 当作本地 CLI 进程执行**（#303 起：`args`→`process.argv`、结果 print 到 stdout、产物写进 cwd、返回值丢弃；MV3 sandbox / `capabilities.scripts` / `script-decl.ts` 死路径已删）；只有 `scripts/` 下声明过的 entry 可执行，LLM 不能注入代码。**产物按 session 隔离**（#296）：cwd = `~/.pie/sessions/<sessionId>/workspace/`（脚本进程唯一可写区，永不写入任何 skill 目录——含只读副根），daemon run 后扫 workspace（mtime>=startedAt）产出 outputs 清单回 observation（文件名是不可信数据，包 `untrusted_skill_output_list`），LLM 用新 read-class tool `read_skill_output({path})`（→ daemon `read_session_file` RPC，`safeRelPath` 锁死在本 session workspace 内）读回；env 注入 `PIE_SKILL_DIR`（读自身资源）/`PIE_WORKSPACE`；生命周期：`lifecycle.ts` 硬删/归档经 SW `delete-session-workspace` message → daemon RPC 清 workspace，daemon 启动 GC 兜底孤儿（>30 天）。作者文档 `docs/agents/skill-authoring.md`。**daemon 连接且声明 `skill_fs` 时磁盘为唯一真源**（`~/.pie/skills/<name>/`，对齐 Anthropic Agent Skills；`SkillSource` 双后端 + builtin 只读层，mode 判定 `bridgeHasSkillFs()`，panel 走 `skills-action` RPC 单路径）；双根：`~/.agents/skills` 为只读副根（跨 agent 通用目录），daemon skill-store 层合并、主根遮蔽同名、写恒落主根（CoW）、副根删除报 `read_only`；副根 skill 默认关（`filterEnabled` 按 `source` 收窄磁盘默认开），首连经 SkillsList 导入向导多选启用（`agents_import_prompted` 标记）；磁盘 skill 脚本经 daemon srt（@anthropic-ai/sandbox-runtime）默认沙箱执行（写限 workspace/默认断网/敏感读拒），首跑弹信封授权卡（panel-request `skill-grant`，daemon 权威 `SkillAuthPayload`，批准带 `approvedEnvelopeHash` 重调堵 TOCTOU，`grantApproved` 不进 JSON schema——LLM 不能自批）；grant 按能力信封记 daemon 独占 `~/.pie/grants.json`（信封变才重弹），设置页「本地打通」可列出/撤销 + 查最近执行（`list_audit`）。daemon-off 时 builtin/idb skill 无可执行脚本（`run_skill_script` 明确报无脚本）。
- `src/lib/sessions/` — Multi-session persistence: state-machine, lifecycle (archive/delete), pinned-tab-registry, title
- `src/lib/crypto.ts` — AES-GCM encryption helper（与 `src/lib/instances.ts` 配合存 instance API key）
- `src/lib/instances.ts` — Multi-instance CRUD; `instance_${uuid}` + `instances_index` + `active_instance_id`
- `src/lib/migration-v2.ts` — V1→V2 silent migration (`provider_*` → `instance_*`)
- `src/lib/provider-custom-models.ts` — per-provider sticky pool（`pcm_${provider}`）跨 instance 共享自定义 model id
- `src/lib/provider-custom-model-meta.ts` — per-provider sidecar 属性表（`pcmm_${provider}`），给 builtin 自定义模型挂 `vision`/`maxContextTokens`（`tools` 恒 true、不可配）；与 `pcm_${provider}` 的 id 池一一对应，删模型时两边连带清
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
3. Load unpacked 加载 `dist/` 目录（指向**主仓库**的 `dist/`，一次指定后只认这个路径）
4. 点击扩展图标打开 side panel

## 本地开发约定（测试直接在主目录切分支）

**要测某个分支 / PR：直接在主仓库主目录 `git checkout <branch>` → `pnpm build`。** 主目录 `dist/` 就是 Chrome 加载的目录（已 gitignore，切分支不动它），build 完让用户去 `chrome://extensions` 点刷新即可测到新代码。**不起 worktree、不跑 `pnpm sync:dist`。**

- 测已有 PR：`git fetch origin <headRef> && git checkout <headRef>`，主目录复用现有 `node_modules`（PR 没改 `package.json` 时无需重装），`pnpm build` 即可；测完 `git checkout main` 还原。
- 需要隔离并行开发时仍可自行起 worktree，但**测试环节一律回主目录切分支 build**；`scripts/sync-dist.sh`（`pnpm sync:dist`）保留但不再是默认路径。

## Release

`.github/workflows/release.yml` 是唯一发布入口。**不要**手动 `gh release upload` 传 zip——除非是已发布 tag 的紧急补救。

发新版流程：
1. bump `package.json` 和 `manifest.json` 的 `version`（必须一致），commit。同一 commit/PR 里产出 release notes：`docs/release-notes/v0.x.y.md`（英文，即 GitHub release body 同源）**＋中文版 `v0.x.y.zh-Hans.md`**——官网 changelog 页（pie-website#12）按页面 locale 从 `raw.githubusercontent.com` 的 `main` 分支拉 `v{ver}.{locale}.md`，404 回落英文，所以中文版漏发不报错、但中文用户就只能看英文；其它语言（如 `.ja.md`）可选，同名规则
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

- API keys: Web Crypto AES-GCM 加密存 IDB `pie` 库 `config` store（`encryption_key`），instance 记录存 `instances` store；instance 维度持久化（不再是旧的 `provider_${id}` 单档）。`crypto.ts` 有 legacy fallback：IDB miss 时读 chrome.storage 旧 key，供升级期解密历史密文
- DOM access: `<all_urls>` host_permission + `chrome.scripting.executeScript`（activeTab 不够 side-panel 常驻场景）
- Streaming: `chrome.runtime.connect()` port，**不用** `sendMessage`；keep-alive 25s `getPlatformInfo()`
- SSE parser 同时处理 `\n` 和 `\r\n` 行尾
- Provider registry pattern: 加 provider = registry entry + 模块文件 + manifest host_permission；capability flags (`vision`/`tools`/`maxContextTokens`) 在 `ModelMeta` per-model 维度；id-keyed dispatch 表 `streamChatByProvider`（builtin）或 `dispatchStreamChat`（custom）。Provider 模块基本是薄 wrapper：OpenAI-compat 家族（openrouter/zhipu/bailian/moonshot）走 `_shared/openai-compat-core.ts`（OpenRouter 用 customHeaders hook；moonshot 双区 = moonshot/moonshot-cn 两条 registry 条目共用同一薄 wrapper）；**openai 例外，自带 `/v1/responses` wire**（`providers/openai.ts`，gpt-5.6 起 chat/completions 上 tools 与 reasoning 互斥被迫迁移；`store:false` 无状态重放，不请求 reasoning summary）；**所有 Anthropic-wire 家族（anthropic/deepseek/minimax/mimo）走 `_shared/anthropic-sdk-core.ts`** —— 官方 `@anthropic-ai/sdk` 后端（#91 起取代手写 SSE core），hooks: `baseUrlSuffix` / `auth(apiKey\|bearer)` / `stripAnthropicVersion` / `promptCache`。per-provider：anthropic = apiKey + promptCache；deepseek/minimax = baseUrlSuffix `/anthropic` + apiKey（minimax base `api.minimaxi.com`，M3 含图片输入）；mimo = baseUrlSuffix `/anthropic` + bearer + stripAnthropicVersion。Gemini 自带 native module。SDK 在 MV3 service worker 里已验证可用：无 eval（CSP-safe），用 fetch/ReadableStream，`process.*`/`Buffer` 引用全被 runtime 探测或鸭子类型 guard，缺失时不执行。同一 provider 的按量/Plan 双端点走 `ProviderMeta.endpointVariants`（id/label/baseUrl + 可选 models/placeholder override），instance 存 `endpointVariant`，`resolveModelConfig` 单点覆盖 baseUrl；加新 Plan 端点 = registry 加一条 variant 数据（+新域名时补 manifest），不动机制代码。
- Custom provider `baseUrl` 在 provider 层定义（`StoredCustomProvider.baseUrl`），instance 不能 override
- Custom provider 一律走 `_shared/openai-compat-core.ts`（OpenAI-compat wire，不带 hooks）
- `<all_urls>` host_permission 是 custom provider fetch（`/v1/models` + streaming）的前提
- Multi-instance config: 同 provider × N instance 独立 nickname/model/apiKey；global `active_instance_id` + per-session `instanceId` override；task start 时 SW snapshot ModelConfig 进 checkpoint，中途改 active 不影响 in-flight loop
- BaseURL 封装: `defaultBaseUrl` 唯一权威，UI 不暴露；老用户手填 baseUrl 在 V1→V2 migration 中静默丢弃
- Injected functions 必须 self-contained（无闭包，args 通过 `executeScript`）
- ChatMessage 始终 string-only（wire format）；AgentMessage IR (`string | ContentBlock[]`) 仅 SW 内部
- Agent Loop: tabId+origin pinning at task start，每轮 origin 重检——但**重检是咨询式（advisory），不再硬停**。origin 漂移 / restricted / tab 关闭 / 仍在导航，统统由 `interpretPinnedTabUrl` 返回 `notice`，loop 把它注入成 trusted `<system_notice>` observation（warn-once，按 `noticeKey` 去重），交给 LLM 自行决定继续 / 恢复 / 调 `fail`。**终止只由 LLM（`done`/`fail`/纯文本）或用户 abort 触发**：loop 无界（无 MAX_STEPS 硬上限，过 `SOFT_STEP_BUDGET` 只升级软提示）。**无任何运行时循环检测 / reflect 干预**——issue #61 的 `loop-detection.ts` + `<reflections>` 自纠正注入已整体移除（误判会吞掉合法的重复动作、污染长程任务上下文）；重复/卡死全交给 LLM 自行判断并调 `fail`（旧的 `generateStuckSummary` / `REFLECTION_GIVEUP_RESULT` / "Max steps reached" 路径更早已移除）。`<system_notice>` 是 trusted runtime 块，不是 `<untrusted_*>`。
- Tool 执行: 无 confirm 层，tool call 直接执行（旧的 risk classifier / `risk.ts` / `sendConfirmRequest` 已移除，见 `src/__tests__/cross-layer/no-confirm-*.test.ts`）；`tool-names.ts` 仅保留 read/write 分类，供 R7 跨 session 锁判定 write-class tool
- Prompt injection 防御: 页面 snapshot 在 user role 用 `<untrusted_*>` wrapper（`untrusted_page_content` / `untrusted_tab_metadata` / `untrusted_user_message`），**never** 进 system role；`untrusted-wrappers.ts` 是唯一 escape 入口
- Per-session sandbox: per-session port (`chat-stream-${sessionId}`) + per-session `pinnedTabs[]` + `currentFocusTabId` (v1.5 multi-pin) + CDP `ownerToken={sessionId,tabId}` + 跨 session R7 lock
- Local daemon bridge: 扩展 ↔ native host (`ai.wiseria.pie`) ↔ `~/.pie/daemon.sock`；wire 类型唯一权威源 `src/types/local-bridge.ts`（daemon 相对 import，加法演进，PROTOCOL_VERSION=1）；桥**意外**断开在 SW 存活期内自动退避重连（1s→30s 封顶，重连尝试自身失败也续排梯子；用户关「本地打通」开关则不重连），SW 唤醒由 `initBridgeAndMigrate()` 兜底（先桥后幂等 IDB→盘迁移的时序不可倒）。handoff 候选表（`daemon/src/agents.ts`）= 唯一 launch 权威（wire 只传 id）：Claude/Codex/Cursor 各 app+terminal 两形态 + OpenCode/Pi terminal，共 8 条；命令必须真机验证过才进表。detect 会问用户 login shell 要 PATH（daemon 跑在 launchd 裸 PATH 下，否则一个 CLI 都看不见）并解出绝对路径，`start.command` 里 exec 绝对路径
- Session 持久化: storage at-rest 持 raw `agentMessages`（LLM resume 需要原始 context），panel render 才走 `redactArgsForPanel`；多 key 原子写走 `writeAtomic`（内部翻译为 `writeSessionBatch`，单 IDB txMulti 跨 sessions + session_index 两 store 原子提交）
- IndexedDB 存储层: 所有扩展状态存单个 `pie` database，含 4 个 object store：`sessions`（会话 meta/agent/archived 记录，id 形如 `${sid}:meta`）、`session_index`（轻量索引单例行）、`instances`（StoredInstance）、`config`（杂项单值 key：encryption_key / active_instance_id / last_model_selection / theme-mode / pcm_*/pcmm_* / custom_provider_* / enabled_skills 等）。跨 store 原子写靠 `txMulti`（D9 原子写不变量保持）。跨上下文变更通知改走 `store-bus`（`BroadcastChannel('pie-store')`，`publishChange` / `onStoreChange`，happy-dom 环境降级进程内），取代旧的 `chrome.storage.local.onChanged`。无 LRU 自动归档（IDB 无 10 MB 上限，只保留 30 天过期硬删 + 手动软/硬删 + 手动归档/恢复）。StorageIndicator 显示 origin 用量估算（`navigator.storage.estimate().usage`），不再有 8 MB 预算/告警/进度条。启动迁移 pipeline（`startup-migrations.ts`）Phase 1（chrome.storage 上游迁移）→ Phase 2（V3 sweep：chrome.storage → IDB 后 clear，schema_version=3，幂等）→ Phase 3（IDB 后迁移）顺序执行，SW 与 panel 两入口共享，两入口均 await pipeline 后才读 IDB。未加 `unlimitedStorage` 权限（manifest 不变）
- PDF capability: Chrome's built-in PDF viewer is sealed, so PDF text is parsed via an MV3 offscreen document running LiteParse v2 WASM (~4 MB, Apache-2.0). The `offscreen` permission + `wasm-unsafe-eval` CSP in `extension_pages` are required. WASM is copied from `node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm_bg.wasm` into `public/liteparse.wasm` at build time (gitignored) and emitted to `dist/liteparse.wasm`. The three PDF tools (`read_pdf` / `search_pdf` / `get_pdf_outline`) route through `src/background/offscreen-manager.ts` which uses `chrome.runtime.sendMessage({target:"offscreen",...})` for request/response. Cache is in-memory in the offscreen doc, keyed by `tab.url`; SW idle → offscreen evicted → re-parse next call. `read_page` returns a `pdf_tab:` error on PDF tabs so the LLM self-corrects to `read_pdf`. New untrusted wrappers `untrusted_pdf_page` / `untrusted_pdf_match` / `untrusted_pdf_outline_entry` are registered in both `UNTRUSTED_WRAPPER_TAGS` (untrusted-wrappers.ts) and `WRAPPER_TAGS_LIST` (page-snapshot.ts) per dual-list invariant. Local PDFs require the user to enable `Allow access to file URLs`; `<PdfPermissionCard>` mounts via `usePdfPermission` when the SW broadcasts `pdf:needs-file-access`.

## Docs Map

- `docs/ROADMAP.md` — 已交付 phases + backlog（single source of truth）
- `docs/agents/auto-acceptance.md` — 自动化真机验收操作文档（Playwright + scratch daemon 全链路跑 `need-human-test` 清单；流程/配方坑/验收标准/报告格式；参考脚本 `eval/acceptance/`）
- `docs/solutions/` — 落地后的 invariant trace docs（per phase / per milestone）
- `docs/specs/` — superpowers `brainstorming` skill 产出（design / requirements / spec），含 Phase 1–3 历史 brainstorm 合并归档
- `docs/plans/` — superpowers `planning` skill 产出（实施 plan），含 Phase 1–3 历史 plan 合并归档
- `docs/release-notes/` — 用户可见 changelog
- `docs/localization/` — 本地化资产：README 多语言翻译（`README.<locale>.md`，如 `README.zh-CN.md` / `README.zh-TW.md` / `README.es-419.md` / `README.ja.md` / `README.pt-BR.md`）+ glossary / launch-pack / qa-checklist。**根目录只留英文 `README.md`**（GitHub 仓库首页只认根 README）；翻译版全部住这里。各翻译版顶部语言切换器互链：英文指 `../../README.md`，同目录兄弟用裸 `README.<locale>.md`，根目录文件（PRIVACY/CHANGELOG/LICENSE）用 `../../`，`docs/` 下文件用 `../`。新增一门语言 = 在此加一份 `README.<locale>.md` + 同步所有切换器（含根 README）
- `docs/design.md` — 早期 Phase 0–3 设计构想（历史档案）
- `docs/archive/index.html` — 项目档案知识库（单文件，vanilla JS / 零依赖）；编辑 `archiveData` 数组 → push 到 main → `.github/workflows/deploy-archive-pages.yml` 自动部署到 https://wiseriaai.github.io/pie-ai-agent/ ；Pages source = GitHub Actions，仅上传 `docs/archive/`，其他 docs/ 不进 Pages

### Convention：superpowers brainstorm / plan 输出位置

- `brainstorming` skill 产出（design doc / requirements / spec）→ `docs/specs/<YYYY-MM-DD>-<slug>.md`
- `planning` skill 产出（实施 plan）→ `docs/plans/<YYYY-MM-DD>-<slug>.md`
- 不再使用 `docs/superpowers/` 子目录或 `docs/brainstorms/`（已合并迁出）
- 历史与新产出在同一目录共存；按文件名日期前缀排序即可区分新旧

## Agent skills

### Issue tracker

Issues live as GitHub issues in `WiseriaAI/pie-ai-agent`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels（issue 状态机 = 任务的事实源）

云端分诊 routine 与实现链共用一套标签状态机；它就是「某个任务现在走到哪了」的唯一事实源，权威清单见 `docs/agents/triage-labels.md`。
- **阶段（分诊产出 + 流转）**：`need-design`（待人牵头产品化设计）/ `need-confirm`（方案已出，待人拍板选项）/ `ready-for-implement`（已充分指定，可交 Loop 实现）。
- **人工信号**：`confirmed` —— 人对 `need-confirm` 拍板后打上，routine 据此补最终方案并推进到 `ready-for-implement`。这是唯一的「人→机」放行闸，不靠机器猜评论。
- **下游状态（实现链产出，分诊只识别、跳过、绝不回退）**：`agent-handling`（Loop 处理中）/ `PR`（已提 PR 等合入）。
- **PR 复审（Step4 Reviewer loop 产出 + 人工信号）**：`need-to-solve`（Reviewer 要求改）/ `solved`（implementer 改完待复审）/ `need-human-test`（过 review 待人真机）/ `human-approved`（人真机过、可合，**由人打**）。Reviewer 与 implementer 同一身份故 review 走普通评论、状态靠标签；无需真机的 PR 由 Reviewer 直合 main（main 保护已放宽 0 approve），`need-to-solve` 由 implementer loop 优先接走（不单设 PR Solver）。**云端无 `gh`，4 条 routine 全走 github MCP（`mcp__github__*`）；git 本地操作走 Bash。详见 `docs/agents/triage-labels.md`「云端执行约束」。**
- **分类 / 分级**：`bug` | `feature` ＋ `P0` | `P1` | `P2`。

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Skill 路由（Matt Pocock skills × superpowers 消歧）

两套 skill 触发器高度重叠，但方法论同源、不矛盾；冲突只在「触发竞争 + 双倍仪式」。按下表分工：

**重叠区一律走 superpowers**（SessionStart 的 `using-superpowers` hook 已默认锁定它，且 Matt Pocock 同名 skill 方法论与之一致）：
- TDD → `superpowers:test-driven-development`（**不**用 Matt Pocock `tdd`）
- 调试 / bug / 测试失败 → `superpowers:systematic-debugging`（**不**用 `diagnose`）
- 写 / 改 skill → `superpowers:writing-skills`（**不**用 `write-a-skill` / `skill-creator`）
- 发散探索需求 → `superpowers:brainstorming`

**Matt Pocock 只用 superpowers 没有的独占能力**：`grill-with-docs`（质询收敛 + 维护 `CONTEXT.md`/ADR）、`improve-codebase-architecture`、`prototype`。

`triage` 与 `to-issues` 这两个 Matt Pocock skill **不再用**：分诊已固化进云端 routine（见上方 Triage labels）；建 issue 按我们自己的 Issue 规范手工走，不走 skill。下面那条 spec-driven 链路是**重点项目才用的 opt-in 流程**，不是默认 —— 详见「开发范式」。

### 开发范式（2026-06 起：云端 Loop 为主，实验期）

> 这份 `CLAUDE.md` 本地与云端共读（云端只读仓库内 `.claude/` + `CLAUDE.md`，不读 `~/.claude/`），**没有单独的 cloud.md**。下面就是两端共同遵守的工作方式 —— 默认**不再跑**旧的 spec-driven 全流程仪式。

**任务源 = GitHub issue + 标签状态机**（见上方 Triage labels）。多数轻量 / 无须人为决策的工作由云端 routine / Loop 经标签流转推进，Loop 之间靠 issue/PR 上的标签与评论交接：

```
新需求 → issue（Step1 分诊 routine 自动归类/分级/定阶段）
       → ready-for-implement → Step3 implementer 实现 → agent-handling → PR
            → Step4 Reviewer 复审：需改→need-to-solve（implementer 接回修→solved→复审↺）
                                  过·无需真机→admin 直合 main
                                  过·需真机→need-human-test→人验收打 human-approved→Reviewer 合
       └ need-confirm → 人打 confirmed 拍板 → Step1 routine 补方案 → ready-for-implement
```

人在这条链上的人工闸有两处：`need-confirm` 处拍板（打 `confirmed`）、与 PR 的真机验收（`need-human-test` → 打 `human-approved`）；其余交给云端。真机验收可先跑自动化预检吃掉大部分清单项（见 `docs/agents/auto-acceptance.md`），人只看报告 + 抽查报告列出的结构性盲区（品牌 Chrome 差异 / 权限弹框流等）。

**默认路径**：不开 brainstorm/grill/plan 仪式。把需求写成 issue（或让分诊 routine 接住），让云端 Loop 实现。本地 session 多做的是「把工作落成清晰的 issue」与「review/merge PR」，**不是亲自实现**。

**重点项目才人为发起设计（opt-in 链，下面这条仅用于重大、含真实不确定性的项目）**：
文档三层 **spec**(`docs/specs/`) → **issue**(GitHub) → **plan**(`docs/plans/`)；不单出 PRD（spec 即「设计＋需求」权威源）。
1. `superpowers:brainstorming` — 产出 spec → `docs/specs/<date>-<slug>.md`
2. `grill-with-docs` — 压测 spec，锐化出的术语/决策写进 `CONTEXT.md` 与 `docs/adr/`（可打回 1）
3. `prototype`（**可选**）— 仅当含状态机/数据模型/UI 方向这类不确定性时才造抛弃式原型，发现回流改 spec
4. **落 issue（按 Issue 规范，不走 `to-issues` skill）** — 把定稿 spec 拆成 tracer-bullet 垂直切片，用 `gh` 手工建 issue（只写 what + 验收标准），照 Triage labels 打分类/分级。**设计已定，issue 直接打 `ready-for-implement`**：跳过 `need-design` / `need-confirm`（那两阶段是给未经设计的新需求分诊用的，不再过云端 routine）。实现 plan（`superpowers:writing-plans` → `docs/plans/`）按需写，作为 issue 的实现参考。
5. **交棒云端 Loop 实现** —— 链路到此为止，本地不接着一把梭：Loop 取 `ready-for-implement` → `agent-handling` → PR → 人 review/merge。
   - 确需本地亲自实现时才走 `superpowers:subagent-driven-development`（每 task TDD）→ `verification-before-completion`（`pnpm test`/`typecheck`/`build` 拿证据）→ `requesting-code-review` → `gh issue close`；收尾走 PR（main 受保护，`gh`，先 `gh auth switch --user WiseriaAI`，`superpowers:finishing-a-development-branch`）。⚠️ subagent cwd 不随 worktree 切换，派活 prompt 须强制 `cd <worktree 绝对路径>`。

**判据**：拿不准是不是「重点项目」→ 默认当轻量任务，落 issue 交云端。仪式是例外，不是 happy path。
