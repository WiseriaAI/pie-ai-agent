# HITL 挂起原语（panel-request）+ 挂起式调度模型卡

**日期**: 2026-06-14
**状态**: spec（待评审 → writing-plans）
**关联**: issue #184（挂起式模型选择卡片）；依赖 #181 PR 已落地的 `ScheduleRecord.model` + schedule 表单复用 `ModelPicker` + `run.ts` 模型解析回退

---

## 1. 问题

Agent loop 里"**SW 挂起一个 turn → 往 panel 发请求 → 等用户 UI 裁决 → resolve/reject 一个 per-session promise → 工具拿着结果继续**"这套人在环（human-in-the-loop, HITL）范式，已经被**独立手搓了两遍**，且 issue #184 正要来第三遍：

| 实例 | 文件 | 返回 | 备注 |
|---|---|---|---|
| CDP 输入授权 | `src/lib/cdp-input-onboarding.ts` | `boolean` | 原型 |
| 本地文件选取 | `src/lib/local-file-request.ts` | `LocalFileResult` | 文件头注释直书 "Mirrors src/lib/cdp-input-onboarding.ts"，多了 timeout |
| 调度模型卡（#184） | 待建 | `(instanceId, model)` | 第三遍 |

两份现存实现结构近乎逐字重复：各自一对 `portsBySession` / `pendingBySession` Map、`register*/unregister*Port`（panel 关闭 → reject）、`requestX()` 发消息返 Promise、`handleXResponse()` resolve。`loop.ts` 里也都是同手法把回调穿进 tool deps（`requestConsent` 在 `loop.ts:1699/1707/1712`、`requestFile` 在 `1722`），真正的阻塞点都在 `loop.ts:2222` 的 `await tool.handler(...)`。

这是典型的 rule-of-three 信号：第三次复制前，把公共原语抽出来。

## 2. 关键澄清：这不是被砍掉的 confirm 层的回归

旧 confirm 层（`risk.ts` 风险分类器 + `sendConfirmRequest`）是**框架主动拦截**——在 write-class 工具执行*前*自动插一道"你确定吗"。它被**刻意移除**，并有跨层测试守着不让复活（`src/__tests__/cross-layer/no-confirm-{emit,pdf,resurrected}.test.ts`）。

本原语服务的是**相反方向**的场景：**工具语义本身就是"问人"**（授权、选文件、选模型）——阻塞是工具的语义，不是框架强加的门。控制权归 LLM/工具，而非框架。CDP 授权与 local-file 这两个*恰恰被保留*，正属此类。

**红线**：本原语**绝不**用于按风险拦截工具调用；不引入任何"框架决定何时该挡"的策略层。命名一律避开 `confirm`，用 `panel-request` / `requestFromPanel`，以免误导并踩 no-confirm 不变量。

（现存唯一的 `SessionConfirmCard` 是 R11 的 pinned-tab-drift / paused-resume 漂移卡，session 级、非 tool 级，与本线无关，不并入。）

## 3. 范围与切片

两个 PR：

- **切片 1（基座，behavior-preserving）**：抽出统一原语 `src/lib/panel-request.ts`，把 `cdp-input-onboarding.ts` 与 `local-file-request.ts` 改成它的薄适配器，两个旧调用点迁过去。行为不变，现有测试当回归网。
- **切片 2（#184）**：在原语上加第一个新 `kind` —— `schedule-model`，做 `ScheduleDraftCard`（复用 `ModelPicker`），接到 `create_schedule` 工具的挂起分支。

## 4. 切片 1：统一原语

### 4.1 模块接口（`src/lib/panel-request.ts`）

```ts
// 一个 session 一个 port，承载整条 HITL 通道（不再每功能一套 Map/port）
const portsBySession      = new Map<string, chrome.runtime.Port>();
// 按 requestId 索引：并发请求不串台，消除旧实现"每 session 至多一个 in-flight"的隐含前提
const pendingByRequestId  = new Map<string, PendingRequest>();
const requestIdsBySession = new Map<string, Set<string>>(); // panel 关闭时批量 reject

interface PendingRequest {
  sessionId: string;
  kind: keyof PanelRequestMap;
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// 类型安全的 kind 注册表：加一种交互 = 加一行，编译期校验 payload/返回类型
interface PanelRequestMap {
  "cdp-consent":    { req: Record<string, never>; res: boolean };
  "local-file":     { req: Record<string, never>; res: LocalFileResult };
  "schedule-model": { req: ScheduleDraftPayload;  res: ScheduleModelSelection };
}

export function registerPanelPort(sessionId: string, port: chrome.runtime.Port): void;
export function unregisterPanelPort(sessionId: string): void; // reject 该 session 全部 pending

export async function requestFromPanel<K extends keyof PanelRequestMap>(
  sessionId: string,
  kind: K,
  payload: PanelRequestMap[K]["req"],
  opts?: { timeoutMs?: number },
): Promise<PanelRequestMap[K]["res"]>;

export function handlePanelResponse(
  requestId: string,
  response: { ok: true; data: unknown } | { ok: false; reason: string },
): void;

// 带外 resolve：保活 CDP "另一个 session 翻开关 → 自动放行 pending" 特例（见 §4.4）
export function resolvePendingByKind<K extends keyof PanelRequestMap>(
  sessionId: string,
  kind: K,
  data: PanelRequestMap[K]["res"],
): void;
```

- `requestId` 用 `crypto.randomUUID()`（MV3 SW 可用）。
- `requestFromPanel` 找不到 port 时 throw（对齐两旧实现：无 panel port 即报错）。
- 无 port 时不静默挂起。

### 4.2 消息信封（统一，取代各功能各自的 message type）

- SW→panel：`{ type: "panel-request", sessionId, requestId, kind, payload }`
- panel→SW：`{ type: "panel-response", requestId, ok, data | reason }`
- 超时通知（可选，per-kind）：`{ type: "panel-request-timeout", requestId }`

旧的 `cdp-onboarding-request` / `request-local-file` / `local-file-response` / `local-file-timeout` 等消息类型在切片 1 内**收敛为上面三条**。

### 4.3 SW 侧收口（`src/background/index.ts`）

当前 port 生命周期已集中在此文件：

- 注册：`1453` `registerOnboardingPort` + `1454` `registerLocalFilePort` → 合并为单条 `registerPanelPort(portSessionId, port)`。
- 响应分发：`1662` `handleOnboardingResponse` + `1667` `handleLocalFileResponse` → 合并为单条 `if (rawMsg.type === "panel-response") handlePanelResponse(rawMsg.requestId, ...)`。
- 注销：`1711` `unregisterOnboardingPort` + `1712` `unregisterLocalFilePort` → 合并为单条 `unregisterPanelPort(portSessionId)`。

### 4.4 迁移暗礁（behavior-preserving 的关键，spec 单列）

CDP 有一个**带外自动放行**特例：`onCdpInputEnabledChanged`（`cdp-input-onboarding.ts:70`）—— 当**另一个 session** 把 cdp-input 开关翻 `true` 时，自动把本 session 等待中的 consent resolve 成 `true`，并发 `cdp-onboarding-resolved` 让卡片消失。

迁移后该特例必须保活：

- `onCdpInputEnabledChanged` 改调 `resolvePendingByKind(sessionId, "cdp-consent", true)`。
- `handleOnboardingResponse` 里 "先 `setCdpInputEnabled(enabled)` 再 resolve" 的持久化副作用，搬进 CDP 适配器 `requestCdpInputConsent` 的 resolve 续作里（`await setCdpInputEnabled(granted)` 后再 return）。因 loop 串行 await 每个 handler，下一个工具读 flag 时持久化已完成，行为等价；重复 set 为幂等。

这是切片 1 里最容易迁丢的一处，必须有针对性测试覆盖。

### 4.5 薄适配器（保持调用方零改动）

旧导出函数名保留为薄包装，`loop.ts` 的工具 deps 装配无须改：

```ts
// cdp-input-onboarding.ts（迁后）
export async function requestCdpInputConsent(sessionId: string): Promise<boolean> {
  const granted = await requestFromPanel(sessionId, "cdp-consent", {});
  await setCdpInputEnabled(granted); // 持久化副作用（§4.4）
  return granted;
}
export function onCdpInputEnabledChanged(enabled: CdpInputState): void {
  if (enabled !== true) return;
  resolvePendingByKind /* 对所有等待中的本类 pending */ ;
}

// local-file-request.ts（迁后）
export async function requestLocalFileFromPanel(sessionId: string): Promise<LocalFileResult> {
  return requestFromPanel(sessionId, "local-file", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
}
```

`registerOnboardingPort` / `registerLocalFilePort` / `unregisterOnboardingPort` / `unregisterLocalFilePort` / `handleOnboardingResponse` / `handleLocalFileResponse` 在收口后由 §4.3 的统一函数取代，旧名删除（同步改 `background/index.ts` 的 import）。

### 4.6 panel 端

panel 端目前 `useCdpOnboarding.ts` / `useLocalFileRequest.ts` 各听各的 message type。迁后：

- 引入一张 `kind → Card` 渲染表；一个统一 hook（或薄分发层）监听 `panel-request`，按 `kind` 决定挂哪张卡片，应答时回 `panel-response { requestId, ok, data }`。
- `CdpOnboardingCard` / `LocalFileRequestCard` 复用，仅改其"如何被触发/如何回话"的接线，卡片本体 UI 不动。

## 5. 切片 2：挂起式调度模型卡（#184）

### 5.1 工具侧（`src/lib/agent/tools/schedule-meta.ts`）

`create_schedule` 的模型解析链当前在 `schedule-meta.ts:160-191`：显式 arg → 当前会话 ctx → `resolveSelection` 兜底 → 错误。在此链上加一个**挂起分支**：

- 用户**显式点名且合法**（instanceId+model 在该实例可用列表）→ 直接建（现状不变）。
- 否则（未点名 / 点名的 model 不在可用列表）→
  ```ts
  const sel = await requestFromPanel(ctx.sessionId, "schedule-model", draftPayload);
  // sel: { instanceId, model } —— 阻塞至用户在卡片提交
  ```
  拿到 `sel` 后走现有 panel→SW 写入链落地，`observation` 同步告知 LLM "已创建"。

`draftPayload`（`ScheduleDraftPayload`）携带待建任务摘要（title / spec / 触发设定）供卡片展示；返回 `ScheduleModelSelection = { instanceId: string; model: string }`。

> 合法性判定（"model 是否在该实例可用列表"）复用现有 `resolveSelection` / 实例模型池逻辑，不新造校验。具体取舍在 plan 阶段定。

### 5.2 panel 侧 `ScheduleDraftCard`

- 复用 Composer 的 `ModelPicker` 选 `(instance, model)`。
- 展示待建任务摘要 + 创建/取消。
- 提交 → 回 `panel-response { ok: true, data: { instanceId, model } }` → 卡翻"已创建 ✓"。
- 取消 → 回 `{ ok: false, reason }` → 工具 handler 收到 reject，返回工具错误，LLM 自行决定后续。
- 与 `CdpOnboardingCard` / `LocalFileRequestCard` 同构，Chat.tsx 内联渲染。

## 6. 生命周期 / 失败模式（三条都要保）

- **panel 关闭** → `unregisterPanelPort` reject 该 session 全部 pending（对齐两旧实现的 panel-close reject）。
- **超时**（per-kind 可选 `timeoutMs`，local-file 沿用 120s；cdp-consent / schedule-model 默认无超时）→ reject + 发 `panel-request-timeout` 让卡片消失。
- **SW 回收** → **容忍**（已定）：pending 随 SW 内存丢失，会话走 `active→paused`（R10 冷启动门，`state-machine.ts:30`），用户 Resume → tool 重跑 → 卡重弹。`requestFromPanel` 的签名与信封刻意做成**存储无关**，将来要 durable 可插 `PendingConfirmRecord.kind="agent-tool"` 预留槽（`sessions/types.ts:48`，M1-U1 占位、从未填实），**本期不实现**。

## 7. 测试策略

**切片 1（回归证明优先）**：

- 现有 `mouse.test.ts` / `editor.test.ts` / `keyboard.test.ts` / `local-file-request.test.ts` / `cross-layer/cdp-input-consent-gating.test.ts` 不改或仅微调即绿 = 迁移无回归。
- 原语 `panel-request.ts` 新单测：requestId 隔离（两并发请求各自 resolve）、panel 关闭批量 reject、超时 reject + 通知、带外 `resolvePendingByKind`、无 port 时 throw。
- §4.4 暗礁专项测试：另一 session 翻 flag → 本 session pending 自动 resolve true + 持久化副作用仍发生。

**切片 2**：

- `schedule-meta` 工具分支测试：点名合法 → 直建不弹卡；未点名/非法 → 调 `requestFromPanel("schedule-model")` 挂起，resolve 后落地。
- `ScheduleDraftCard` 组件测试：渲染摘要 + ModelPicker，提交回 `data`，取消回 `reason`。

## 8. 不做（YAGNI）

- ❌ 不复活 risk-gating confirm 层（§2 红线，`no-confirm-*` 跨层测试守着）。
- ❌ 不做持久化 suspend/resume（留接口口子，不实现）。
- ❌ 不引入 requestId 之外的并发编排（一次一个挂起卡对用户已足够；并发能力仅为防串台与 future-proof）。
- ❌ 不改 `CdpOnboardingCard` / `LocalFileRequestCard` 的卡片本体 UI（只改接线）。

## 9. 验收标准（汇总 #184 + 基座）

切片 1：

- [ ] `src/lib/panel-request.ts` 落地；CDP / local-file 两调用点迁移完成，旧专用 Map/port/message 删除。
- [ ] `background/index.ts` port 注册/响应/注销三处收口为统一函数。
- [ ] §4.4 CDP 带外自动放行 + 持久化副作用行为保持，有专项测试。
- [ ] 全量 `pnpm test` / `pnpm typecheck` / `pnpm build` 绿。

切片 2（#184）：

- [ ] chat 建 schedule：模型明确且合法 → 直接创建；否则弹 `ScheduleDraftCard`。
- [ ] 卡片复用 `ModelPicker`，用户选 `(instance, model)` + 提交 → 走现有 panel→SW 写入链落地。
- [ ] 挂起式：工具 `await` 至用户提交后 resolve，LLM 同步看到"已创建"。
- [ ] SW 回收策略 = 容忍（对齐 CDP），无持久化。
