---
date: 2026-05-12
topic: iframe-page-awareness
spec: docs/specs/2026-05-08-iframe-page-awareness-design.md
plan: docs/plans/2026-05-12-iframe-page-awareness.md
status: shipped
related:
  - https://github.com/WiseriaAI/pie-ai-agent/issues/42
---

# iframe Page Awareness — Invariant Trace

R-iframe-1..5 落地点 + 守护测试 + 守护 commit。

## R-iframe-1 selector duality

写类工具（click/type/select）必须用 (frameId, elementIndex) 二元组；scroll 的 frameId 可选缺省 0。Handler 注入用 `target.frameIds`，不用 `allFrames`。

| 落地 | 位置 |
|---|---|
| Schema required[] | `src/lib/agent/tools.ts` — click/type/select 的 `parameters.required` 含 `frameId` |
| Handler frameIds 注入 | `src/lib/agent/tools.ts` — `execInTab(tabId, fn, args, frameId)` 第 4 参数 |
| Build-time assertion | `src/lib/agent/tools.ts` 文件末 IIFE `assertWriteToolsRequireFrameId` |
| 守护测试 | `src/lib/agent/loop.test.ts` — resolveElement 接收 frameId（默认 0） |

## R-iframe-2 read fan-out 一致性

SW-level 读类入口必须走 `allFrames: true`。新增读类调用必须自检并加入列表。

`READ_FANOUT_CALLSITES`（review checklist，2026-06-10 按 `rg -n "allFrames: true" src/ --type ts` 实测更新）:
1. `src/lib/agent/tools/read-page.ts:230` — read_page atlas/auto 路径 fan-out（`probePageInjected {op:"atlas"}`）
2. `src/lib/agent/tools/read-page.ts:287` — read_page snapshot 路径 fan-out（`probePageInjected {op:"snapshot"}`）
3. `src/lib/agent/tools/search-page.ts:117` — search_page fan-out（`probePageInjected {op:"search"}`）
4. `src/background/index.ts:416` — `handleExtractPage`（@page chip / Settings 抽页）

旧清单失效说明：`src/lib/agent/frame-discovery.ts:getAllFramesAndDiff` 集中入口及其测试已随 PR #152/#159 重构删除；loop.ts 不再每轮 snapshot（读页改由 read_page tool 按需触发）；`get_tab_content`（tabs.ts）已不存在。fan-out 现直接在各 callsite 以 `chrome.scripting.executeScript({allFrames: true})` 完成。

| 守护 | 位置 |
|---|---|
| 守护测试 | `src/lib/agent/tools/read-page.test.ts:182` — 断言 `target` 为 `{ tabId, allFrames: true }` |

## R-iframe-3 per-frame untrusted wrapper

LLM context 的页面文本必须按 frame 分段、每段 wrapper 带 `frame_id`（含 unreachable 段）。cross-origin 帧 wrapper 必须带 `cross_origin="true"`。attribute 值走 `escapeWrapperAttribute`。

| 落地 | 位置 |
|---|---|
| 渲染层 | `src/lib/agent/prompt.ts:renderFrameBlock` + `buildObservationMessage` |
| Attribute sanitize | `src/lib/agent/untrusted-wrappers.ts:escapeWrapperAttribute` |
| Wrapper-tag literal escape | `escapeUntrustedWrappers`（保持现状，已防御 8 类 bypass） |
| 守护测试 | `src/lib/agent/prompt.test.ts` — multi-frame rendering tests |

## R-iframe-4 pin 不下沉

`SessionMeta.pinnedTabs` schema 不变；不引入 pinnedFrames / allowedOrigins。

| 守护 | 位置 |
|---|---|
| Storage schema 未变 | `src/lib/sessions/storage.ts` SessionMeta — 本 plan 未触碰 |
| Review checklist | 任何 future PR 加 frame 级 pin 字段都必须重审本 invariant |

## R-iframe-5 cross-origin frame 不入决策路径

cross-origin frame 信息仅透传到 LLM。不复活 risk classifier / confirm card / hard-stop / pause 分支。

| 守护 | 位置 |
|---|---|
| 缺席的代码 | `src/lib/agent/risk.ts` 整文件已删（2026-05-08 confirm 删除） |
| Grep guard test | `src/__tests__/cross-layer/no-confirm-resurrected.test.ts` — fs grep `classifyRisk` / `RiskClassifyContext` / `pendingConfirmations` 必须 0 hit |
| 行为 regression | 同文件前两个 case — multi-frame snapshot / get_tab_content with cross-origin frame 后 emit 队列必须 0 `agent-confirm-request` |

## 2026-06-10 更新 — click 分路径（spec: docs/specs/2026-06-10-iframe-click-split-path.md）

#81 的 CDP click 升级曾使 iframe 内 click 依赖 chrome↔CDP frame 映射（URL 启发式 +
Page.getFrameTree），OOPIF 下必断（`frame mapping failed`）。现改为：

- click frameId>0 → frame 内合成点击（act-core `click` op，经 `exec-act.ts`），不走 CDP。
  R-iframe-1 的 (frameId, elementIndex) 二元组与 schema required 不变。
- hover frameId>0 → 明确报错（top-frame only）。
- `geometry.ts` 的 `resolveChromeToCdpFrameId` 整套映射已删除。
