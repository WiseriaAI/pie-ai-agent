---
date: 2026-05-04
topic: tabs-create-multi-pin
---

# Chrome 标签控制 v1（open_url + multi-pin）

> **历史 note**：本 doc 初稿包含 `nav_pinned_tab` cross-origin nav，2026-05-04 review 暴露 4 P0 + 估时 1-2 周 → 2-3 周；用户选 multi-pin 简化 + drop nav。`nav_pinned_tab` 推 v1.1 单独 brainstorm，会带上原稿的 4 invariant 互动设计（R6 inTransitOrigin / R7 atomic swap / R9 CDP detach / R10 task-mutex）。

## Problem Frame

Phase 3 已交付 7 cross-tab 工具（list / get_content / close / activate / group / ungroup / move），缺**创建** tab 的能力。同时 M2/M3 的 single pinned tab 模型让 'agent 在 multi-tab workflow 下需要灵活在多个 tab 间移动' 变得不自然——agent 必须 close + open + 重 pin 才能"换上下文"。

v1 做两件事：
1. 引入 `open_url(url, active=false)` — agent 创建新 tab 含 URL，加入当前 session 的 pinned tabs 数组
2. **将 pinned tab 从 single 升级为 array**——sibling sessions 之间不冲突，open_url 自然加入而不是替换

跨 origin 导航（`nav_pinned_tab`）不在 v1——它牵动 4 个不变量复杂度（review 暴露），推 v1.1 单独 brainstorm。

## Requirements

**新工具**

- R1. 注册 `open_url(url: string, active?: boolean)` tool —— 在 current window 末尾创建新 tab；`active` 默认 `false`（background 不抢焦点）
- R2. 创建的新 tab 自动加入当前 session 的 `pinnedTabs` 数组——**不替换**已有 pin，不**收回**已有 pin

**Multi-pin schema 升级**

- R3. `SessionMeta` schema：`pinnedTabId?: number` + `pinnedOrigin?: string` → `pinnedTabs?: Array<{ tabId: number; origin: string }>`（保留 single 字段为 deprecated alias 一段时间，平滑迁移）
- R4. `SessionIndexEntry` schema：`pinnedTabId?: number` → `pinnedTabIds?: number[]`（cross-session R7 lock 读取的字段）
- R5. M2/M3 已有 session 一次性 migration：迁移函数把 single `{pinnedTabId, pinnedOrigin}` → `pinnedTabs: [{tabId, origin}]` 单元素数组；`pinned-tab-registry.ts.captureActivePinned` 的 first-message capture 行为改为 push 进 array 而非 set 单值

**URL allow-list**

- R6. `open_url` 必须用 `new URL(input)` 解析后**显式 allowlist** 断言 `url.protocol === 'http:' || url.protocol === 'https:'`；其他 scheme（含 `view-source:` / `mailto:` / `ws:` / `wss:` / `ftp:` / `intent:` / `chrome:` / `chrome-extension:` / `file:` / `data:` / `blob:` / `javascript:` 以及未来 Chrome 引入的新 scheme）reject + 返回观察 `unsafe-url-scheme`。Allow-list 而非 deny-list 避免新 scheme 默认放行
- R7. URL nil / 空字符串 / 非 string / `URL()` throw 各自 return 结构化 isError tool-result（LLM 重 plan，**非** task abort）

**风险分类**

- R8. `open_url` 加进 `risk.ts` 的 `ALWAYS_HIGH_TAB_TOOLS`，避开 Phase 3 G-1 acceptance gate；每次 dispatch 走 confirm card
- R9. confirm card 显示 (a) URL 全文（≥1024 chars 折叠 expand），(b) origin（IDN 用 punycode `xn--` 形式以防 homograph），(c) `active=true` 时显式标记 "will steal focus"，(d) `active=false` 时显式标记 "will load in background and execute"
- R10. confirm card payload 沿用 Phase 3 P3-V baseline（role=dialog / aria-labelledby / OriginSummaryRow role=status）

**Skill capability**

- R11. skill `allowedTools` 可包含 `open_url`；R10 first-run-confirm + 每次 dispatch confirm card 双重 gate
- R12. skill 含 `open_url` 在 SkillsList UI 创建/编辑时显式标记 "每次新开 tab 需用户授权"

**Cross-session 行为**

- R13. `pinnedTabs` 数组在 multi-session 下：sibling session B pin 同 tabId 是被允许的（pin 是 set，set 交集不算冲突）；R7 cross-session lock 仍 fire 在 **write tools 命中** sibling session 当前 active task tab 时，与现有逻辑一致——multi-pin 不削弱 R7 安全 baseline
- R14. `open_url` 创建的 new tab **不会**和 sibling sessions 冲突（new tab 必然不在任何 sibling session 的 pinnedTabs 中）

## Success Criteria

- agent 调 `open_url("https://example.com")` 在 background 开新 tab，pinnedTabs 数组从 N 增到 N+1
- 同一 session 多次 open_url 不替换已有 pin
- sibling sessions 各自 pin 同一 tabId 不互相 R7 reject（multi-pin 自然支持）
- M2/M3 已有 single-pin sessions 自动 migrate 为单元素数组，行为 100% 兼容
- `open_url` 收 unsafe URL scheme 在 dispatch 前 reject + 返回 `unsafe-url-scheme` 观察
- IDN 域名（如 `xn--80akhbyknj4f.com`）在 confirm card 用 punycode 形式显示而非渲染原 Unicode

## Scope Boundaries

- 不做：`nav_pinned_tab`（cross-origin pinned-tab 内导航）—— 推 v1.1 单独 brainstorm，会带 R6 inTransitOrigin / R7 atomic swap / R9 CDP detach / R10 task-mutex 4 invariant 设计（即原 doc 1-2 周 scope 整套推迟）
- 不做：R11 click-induced false-positive 修复 —— click → 同 origin nav 触发 origin re-check 的 false-positive 问题是独立 brainstorm 话题，不在 v1（虽然 ADV-1 review 指出这是真实痛点）
- 不做：`tabs.duplicate` / `nav of non-pinned-tab` / cross-window `open_url`（与 G-2 acceptance gate 一致）
- 不做：incognito window（manifest 不加 `incognito: spanning`）
- 不做：URL phishing reputation 黑名单 —— v1 信任 confirm card 用户授权；R6 unsafe-scheme allowlist 是 v1 必做硬约束（不与此条冲突）
- 不做：`pinnedTabs` 数组容量上限 —— v1 不 cap，由 list_tabs 50 cap 间接限制（一个 session 不可能 pin 50+ tab）；v1.1 看实际使用数据再 cap
- 不做：自动从 pinnedTabs 移除 closed tabs —— pinned tab 关闭后保留 stale entry，下次 tool dispatch 时 chrome.tabs.get reject 自然清理

## Key Decisions

- **pinnedTabs 是 array 不是 single**：原 single-pin 模型是为"agent 任务始末锁定一个 tab"，但 multi-tab workflow 让模型变成阻碍。Multi-pin 让 sibling sessions 共享 tab 不冲突 + open_url 加入 array 而非 swap。这是 forward 升级，不影响 single-tab agent task 行为
- **drop nav_pinned_tab v1**：cross-origin nav 牵动 4 invariant 互动 + 估时 1-2 周（review ADV-1 还指出多步表单实际是 click-induced nav 而非 nav 工具能解）；推 v1.1 单独 brainstorm 让设计 mature
- **open_url always-high**：与 close_tabs / group_tabs 等 mutation 工具一致；避开 G-1 SkillDefinition.allowedTools schema 升级
- **URL allow-list R6**：必须显式 `protocol === 'http:'||'https:'`，避免 deny-list 漏列新 scheme（view-source / mailto / intent 等）默认放行
- **IDN punycode 显示**：confirm card 渲染 host 用 `xn--` 形式防 homograph 攻击；这是 1 个 implementation 一致性细节，列为 R9 不留 plan 阶段决定
- **不引入 task-mutex**：用户提议明确"不用加锁"——open_url 创建新 tab 无 per-tab 共享 state mutation，无需 task-mutex；多次并发 open_url 各自走 confirm card + chrome.tabs.create，由 SEC-PLAN-009 cross-session flood-limit 自然 cap

## Dependencies / Assumptions

- Phase 3 cross-tab 机制可复用：confirm card / risk classifier / TAB_TOOL_NAMES / OriginSummaryRow / collectCrossSessionConflicts
- M3 per-session pinned 已就位（PR #13）；Multi-pin 是 schema 升级而非新建机制
- M2-U2 wire shape 不需要修改（confirm-request 已支持 origin 字段）
- `pinned-tab-registry.ts` 当前的 `captureActivePinned` 路径需要小改（push 进 array vs set 单值）

## Outstanding Questions

### Resolve Before Planning

- [Affects R3, R4, R5][Technical] **schema migration 路径细节**：现有 sessions 走一次性懒迁移（首次读写时升级）还是 startup eager 迁移？migration 失败 fallback 行为？M3 trace doc 必须更新（multi-session locality regression test 加 multi-pin case）
- [Affects R13][Technical] **每 tool 调用 tabId 选择策略**：当前 tab tools 默认 `ctx.pinned.tabId` 单值；multi-pin 后所有 tab tool 是 (a) 强制 args 显式 tabId，(b) 默认 `pinnedTabs[0]`（最早 pin 的），(c) 默认 `pinnedTabs[N-1]`（最近 pin 的，agent 任务直觉），(d) 默认 active tab。每个选项对 tool 兼容性有不同影响
- [Affects R13][Technical] **R7 cross-session lock 在 multi-pin 下的细节**：sibling session B 的 pinnedTabs 中含 tabId X，session A 的 write tool 命中 tabId X 时——R7 lock 是 fire 还是允许？现有 read/write 分类 + cross-session 锁的语义需要在 multi-pin 下重述
- [Affects R6][Technical] **URL.protocol allow-list 在 percent-encoded scheme 的边界**：`https%3A//example.com` 解析为 protocol === ''（不是 'https:'）；`/example.com`（无 scheme，relative）—— 各自处理路径需 enumerate

### Deferred to Planning

- [Affects R1][Technical] **`open_url` 工具名 + 参数 schema** 设计（candidate: `open_url` / `create_tab` / `tabs_create`）
- [Affects R8][Technical] **批量 open_url 与 confirm fatigue**：单 session 顺序 dispatch 5 个 open_url 在第 6 次 hit SEC-PLAN-009 (>5 simultaneously) 触发条件**几乎不可能**（每个 confirm 用户答完才到下一个 dispatch）；真实顾虑是 K-10 per-task `confirmRejections` (3-reject task abort) ——用户连续 reject 3 次开 tab 是否触发 task abort，plan 阶段决定 (a) 计入 K-10，(b) 给 nav-skill 独立 counter，(c) reject 不计 K-10
- [Affects R9][Design] **active=true 与 active=false 的 confirm card 文案差异**：用户对"会抢焦点"vs"后台运行"的语感差异如何 UI 化
- [Affects R12][Design, UX] **SkillsList UI 标记 'open_url skill 每次需授权'**：inline icon + tooltip 或 badge 或创建时一次性 modal
- [Affects R6][Technical] **URL 长度上限**：≥2048 chars 直接 reject 还是允许 + confirm card 折叠？v1 倾向 1024 折叠 / 4096 reject
- [Affects R3, R4][Technical] **single-pin field 字段是否完全废弃 vs 保留 deprecated alias**：保留 alias 简化 migration 但代码膨胀；完全废弃简洁但破坏 forward compat

## Next Steps

→ `/ce:plan` for structured implementation planning。Plan 阶段 unit-1/2/3 必须先解 Resolve-Before-Planning 4 项（schema migration 细节 / tabId 选择策略 / R7 cross-session 在 multi-pin 下行为 / URL.protocol 边界），再展开后续 unit。预估 ~5-7 unit 跨 2-3 天（multi-pin schema migration 是主要时间消耗，open_url 本身 < 1 天）。
