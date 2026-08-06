# Provider RPM 限流 + 模型列表样式改版 — 设计 spec

- 日期：2026-08-06
- 状态：已确认（brainstorm 定稿）
- 范围：pie-ai-agent 单仓库，无后端/契约改动
- UI 设计稿：brainstorm 会话内 HTML mockup 已确认（instance 表单新增字段 / Chat 等待指示 / 模型列表行卡化三处）

## 1. 背景与目标

部分 provider 有 RPM（每分钟请求数）限额，撞上即 429。现状客户端**零主动限流**，且存在真实并发：title 生成 fire-and-forget 与 agent loop 首轮并发发出、多窗口多 session、schedule 无头运行。目标：

1. 用户可在 instance 上配置 RPM 上限；聊天链路主动节流，撞不到服务端限流。
2. 达到自设上限时**排队等待而非报错**，侧栏有可见的等待指示。
3. 顺带确认的 UI 变更：设置页模型列表（`ProviderModelList`）改为行卡样式（见 §6）。

**明确不做**：服务端 429 自动重试（另立 issue）、per-provider 共享限流池、计数持久化、provider 连通性测试限流、managed provider 暴露此配置（其表单是 `ManagedAccountPanel`，限流由后端管）。

## 2. 已拍板的决策

| 决策点 | 结论 |
|---|---|
| 配置与计数维度 | **instance 维度**（RPM 现实中绑 API key；同 provider 两把 key 各自限额；custom provider 也经 instance 使用，统一生效） |
| 撞限行为 | **排队等待 + UI 提示**（不报错；abort 可打断） |
| 服务端 429 | 不处理，维持现状报错终止 |

## 3. 配置层

### 3.1 数据

- `StoredInstance`（`src/lib/instances.ts`）加可选 `rpmLimit?: number`。正整数；`undefined` = 不限。加法演进，IDB 无迁移。
- `updateInstance` patch 接受 `rpmLimit`（含显式清除回 undefined）。
- `resolveModelConfig`（`src/lib/instances.ts:191`）把 `rpmLimit` 与 `instanceId`（计数 key）透传进 `ModelConfig`。`ModelConfig` 加可选 `rpmLimit?: number` 与 `rateKey?: string`（= instanceId）。
- 语义与现有 instance 配置一致：`ModelConfig` 是 task-start snapshot，**中途修改 rpmLimit 不影响 in-flight loop**，下个任务生效。

### 3.2 表单 UI（已确认 mockup）

- `InstanceFormPayload` 加 `rpmLimit?: number`；`InstanceForm.tsx` 在 **API Key 与「模型」之间**新增字段：
  - label「每分钟请求上限」，右上角 mono hint「RPM」，沿用现有 `Field` 组件样式。
  - 数字输入框（现有 input 样式），placeholder「不限」，只收正整数；空/0/非法 → 存 `undefined`。
  - 下方 11px `text-fg-3` 说明：「按服务商限额填写，留空则不限制。达到上限时新请求自动排队等待，不会报错中断。」
- 两个宿主透传保存：编辑页 `ModelsPage.tsx`（`handleSaveEdit` → `updateInstance`）与新建向导 `NewConfigWizard.tsx`。
- managed provider 分支（`provider === "managed"`）不渲染此字段。

## 4. 限流器

### 4.1 模块

新文件 `src/lib/model-router/rate-limiter.ts`：

- 模块级 `Map<string, number[]>`：rateKey（instanceId）→ 60s 窗口内的请求时间戳。
- 两个导出（拆开是为了让 streamChat 能在 await 前先 yield 等待事件）：
  - `peekWait(key: string, limit: number): number | null` — 窗口未满返回 `null`；已满返回预计恢复时刻 `resumeAt`（epoch ms）。纯读，不记账。
  - `acquire(key: string, limit: number, signal?: AbortSignal): Promise<void>` — 窗口内计数 < limit 则记入时间戳立即返回；已满则 sleep 到最早一条过期，醒来**重查**（while 循环；JS 单线程无 TOCTOU，多个 waiter 按事件循环顺序竞争，天然公平够用）；`signal` abort 立即以 `AbortError` 拒绝，不记时间戳。
- SW 重启计数清零 → 最坏窗口内多发几条，可接受（`ponytail:` 注释标明：内存滑动窗口，SW 重启即清零；若未来要跨重启精确，升级为 IDB 持久化时间戳）。
- 测试需要可注入时钟（`now()` 参数或依赖注入），不 mock 全局 Date。

### 4.2 挂载点：`streamChat`

`src/lib/model-router/index.ts:104` `streamChat` 在调 `dispatchStreamChat` 前：

```
config.rpmLimit 有值 →
  const resumeAt = peekWait(rateKey, rpmLimit)
  resumeAt !== null → yield { type: "ratelimit-wait", resumeAt }（StreamEvent 新 variant）
  await acquire(rateKey, rpmLimit, signal)   // 未满时同步记账直通，满时排队
```

- `StreamEvent` 加 `{ type: "ratelimit-wait"; resumeAt: number }`（epoch ms）。
- 覆盖路径自动全含：agent loop 主请求（`loop.ts:2026`）、title 生成（`chat()`）、上下文压缩（`compact-react-window.ts`）、schedule（走 loop）。这四条共享同一 instance 的同一计数器——title 与首轮并发正是最易撞限的场景，由计数器天然串行化。
- `provider-test.ts` 直调 `dispatchStreamChat`，不经过限流，保持现状。
- title/compaction 的事件消费对 `ratelimit-wait` 自然忽略（非穷举 switch；若有穷举处由 `pnpm typecheck` 暴露，补 no-op 分支）。

## 5. 等待 UI 指示（已确认 mockup）

### 5.1 消息协议

- `src/types/messages.ts` 加 SW→panel 消息 `{ type: "chat-ratelimit-wait"; sessionId: string; resumeAt: number }`。
- `loop.ts` 的 streamChat 事件循环收到 `ratelimit-wait` → 经 port 发出上述消息。title/compaction 路径不发（无 port 语义）。

### 5.2 Panel 渲染

- `Chat.tsx` 的 `WorkingIndicator` 加等待变体：收到 `chat-ratelimit-wait` 进入 waiting 态；PieFace 保持 `thinking` 态三点跳动（**不加 PieFace 新状态**），caps 文案换为「限流等待 · N 秒」，颜色用主题现成的 `--c-pending`（黄铜，排队语义专用色），与灰色「思考中」区分。
- 倒计时由 panel 本地按 `resumeAt` 每秒刷新，`tabular-nums` 防跳动；计算结果钳在 ≥0（waiter 竞争可能让实际恢复晚于 `resumeAt`，显示停在 0 直到真实进展消息到来）。
- 清除条件：收到任一真实进展消息（`chat-chunk` / `thinking-chunk` / `agent-step` / `chat-error` / `chat-done` / `agent-done-task`）即退出 waiting 态。abort 走现有停止路径（acquire 被 signal 打断，loop 正常终止）。
- i18n：新 key（如 `chat.ratelimitWait`，带 `{seconds}` 插值）进全部 6 门字典（en / zh-CN / zh-TW / ja / es-419 / pt-BR），parity 测试兜底。

## 6. 模型列表样式改版（已确认 mockup）

`ProviderModelList.tsx` 纯样式重构，**行为与 props 不变**：

| 元素 | 现状 | 新样式 |
|---|---|---|
| 容器 | 整块 `bg-field` 圆角容器内嵌行 | 透明容器，`flex flex-col gap-1.5` |
| 模型行 | 无边框行 `px-3 py-2` | 每行独立 `border border-line rounded-[10px] px-3 py-2`；mono 11px；builtin `text-fg-2`、custom `text-fg-1` |
| VISION/TOOLS chip | 胶囊 `bg-accent-tint` | 描边方角 mono 小标签：`border border-line rounded-[4px] font-mono text-[9px] text-fg-3 px-[5px] py-px` |
| 「自定义」分组头 | 灰底横条（`border-y bg-canvas`） | 裸 caps 小标：`font-mono text-[9px] uppercase tracking-[0.1em] text-fg-3`，无背景 |
| 添加自定义模型 | 容器底边 `border-t` 按钮 | 虚线描边行：`border-[1.5px] border-dashed border-line rounded-[10px] text-accent`，内容居中 |
| 懒加载「刷新」条 | 容器内 `border-b` 首行 | 信息与位置不变，独立成列表上方一行，样式适配散卡布局（无边框小字行） |
| 自定义行编辑/删除图标、`ModelMetaEditor` | — | 不动 |

不引入「默认模型」标签——此列表无选模语义（模型选择在 Composer ModelPicker）。

## 7. 测试

- `rate-limiter.test.ts`：窗口滚动过期、满窗排队后放行顺序、多 waiter 竞争、abort 打断（注入时钟）。
- `streamChat` 集成（mock dispatch）：`rpmLimit=1` 连发两条 → 第二条先产出 `ratelimit-wait` 再正常流式；无 `rpmLimit` 零开销直通。
- `InstanceForm`：rpmLimit 输入合法化（正整数 / 空 → undefined）与 payload 透传。
- `ProviderModelList`：现有行为测试保持绿（样式类断言如有则更新）。
- i18n parity 既有测试覆盖新 key。
- 提交前 `pnpm test` / `pnpm typecheck` / `pnpm build`。

## 8. 验收清单（真机）

1. instance 配 RPM=2，连续发起任务：第 3 个请求起侧栏出现黄铜色「限流等待 · N 秒」倒计时，窗口空出后自动继续，任务不报错。
2. 等待中点停止 → 立即中断，无悬挂。
3. title 生成与首轮并发被计入同一窗口（RPM=1 时可观察到串行）。
4. 留空 RPM → 行为与现状完全一致。
5. 设置页模型列表呈现行卡新样式，custom 模型编辑/删除、添加、懒加载刷新均正常。
