---
date: 2026-05-08
topic: iframe-page-awareness
status: brainstormed
related:
  - https://github.com/WiseriaAI/Pie/issues/42                       # 主 issue（feat: agent 跨 iframe 的页面感知与操作）
  - https://github.com/WiseriaAI/Pie/issues/38                       # 划词引用 v1（被 #42 阻塞）
  - src/lib/dom-actions/snapshot.ts                                  # snapshotInteractiveElements 注入函数
  - src/lib/dom-actions/click.ts / type.ts / select.ts / scroll.ts   # 写类注入函数
  - src/lib/agent/loop.ts                                            # 每轮 snapshot + extractPageContentHardened pre-fetch
  - src/background/index.ts                                          # extractPageContent (@page chip / Settings 抽页)
  - src/lib/agent/risk.ts                                            # 现有 cross-origin (tab 维度) 分类
  - src/lib/agent/untrusted-wrappers.ts                              # `<untrusted_*>` wrapper escape
  - src/lib/agent/tools.ts                                           # click/type/select/scroll tool schema
  - manifest.json                                                    # 需新增 `webNavigation` permission
---

# Agent 跨 iframe 的页面感知与操作

## Problem Frame

当前 agent 所有 page-level `chrome.scripting.executeScript` 调用只传 `target: { tabId }`，未带 `allFrames: true` —— 只能看到 main frame。受影响入口：

- `snapshotInteractiveElements`（每轮 ReAct 观察）
- `extractPageContent`（background：`@page` chip + Settings 抽页）
- `extractPageContentHardened`（loop SEC-2 pre-fetch：`get_tab_content` 工具的预取）
- `clickByIndex` / `typeByIndex` / `selectByIndex` / `scroll`（写类工具）

后果：iframe（same-origin 与 cross-origin 都受影响）对 LLM 完全不可见、无法操作。Notion / 飞书 / Google Docs 类嵌入式编辑器、嵌入式登录/支付 widget、第三方文档预览等场景下 agent "失明"。

`<all_urls>` host_permission 已就位，能向 cross-origin frame inject。但 sandboxed iframe / 严格 X-Frame-Options / chrome-extension child 仍是注入边角，需要 surface "不可访问"。

Phase 3 cross-tab trust model 有 origin / risk 分类先例，但"同 tab 内多 origin"是新语义，需要独立设计而不是直接复用。

## Decisions Locked During Brainstorm

| Q | Decision | Rationale |
|---|---|---|
| **首批用户场景** | 全场景齐头并进（read + write + risk + UX 一次闭环） | 一致性最佳；分批走会留下"@page 看不到但点击能看到"的认知裂隙，#38 划词引用阻塞 |
| **Snapshot 数据形状** | 嵌套 `frames[]`，每 frame 独立 `elements[]` 与 per-frame elementIndex 计数 | LLM 看到层级清晰、能按 frame 推理；天然契合 stamp 属性 per-document 的 DOM 现实 |
| **Selector schema** | click/type/select 的 `frameId` **必填**，top frame = 0；scroll 的 `frameId` 可选缺省 0 | 写类元素寻址有歧义（per-frame index 不带 frameId 不唯一），必填强制 LLM 决策；scroll 无 element ref 不模糊，可选避免日常顶层操作冗长 |
| **cross-origin frame 风险升级** | 复用现有分级逻辑 + cross-origin frame **入 reason 不升 level** | 避免广告 / 第三方 widget 装载频发 confirm；敏感字段 / submit / 关键字 / cross-tab 仍按原路径升 high |
| **不可达 frame 表达** | 与可达 frame 同列于 `frames[]`，标 `unreachable: true`，携 frameUrl/origin/reason，不携 elements | LLM 与用户都能看见盲区；不另起 unreachableFrames[] 数组，单一数据结构最简 |
| **Pin 粒度** | 维持 tab 粒度，iframe 不另起 pin / allowedOrigins 列表 | M3-U 状态机不动；cross-origin frame 是 risk reason 来源，不是 trust boundary |
| **读类入口范围** | snapshot / extract_page_content / SEC-2 pre-fetch **三条路线全部** allFrames，全部 per-frame untrusted_page_content wrapper | 一致性最高；@page chip 与 click 都看见 iframe，避免认知裂隙 |

## Architecture

### 1. executeScript 调用形态

| 路径 | target 形态 | 注入函数 |
|---|---|---|
| Loop 每轮 snapshot | `{ tabId, allFrames: true }` | `snapshotInteractiveElements` |
| `extractPageContent`（background） | `{ tabId, allFrames: true }` | `extractPageContent` |
| `extractPageContentHardened`（SEC-2） | `{ tabId, allFrames: true }` | `extractPageContentHardened` |
| `click` / `type` / `select` 写入 | `{ tabId, frameIds: [frameId] }` | 现有 `clickByIndex` / `typeByIndex` / `selectByIndex` |
| `scroll` | `{ tabId, frameIds: [frameId ?? 0] }` | 现有 `scroll` |

写类用 `target.frameIds` 单点注入，避免 `allFrames: true` 后所有 frame 都执行（即便 idx 不存在）的浪费与日志噪声。

### 2. Frame 树发现

读类路径在 `executeScript` 之前先调 `chrome.webNavigation.getAllFrames({ tabId })` 拿到完整 frame 树（每条 `{ frameId, parentFrameId, url, errorOccurred }`），与实际 `executeScript` 返回的 `InjectionResult[]` 做 diff，得到 unreachable 集合。

reason 推断规则（best-effort，spec 内不视为法律定义，只是给 LLM 与用户的提示）：

| 条件 | reason |
|---|---|
| URL 以 `chrome-extension://` 开头 | `extension-child` |
| URL 是 `about:blank` 且 `errorOccurred=false` | `about-blank` |
| `errorOccurred = true`（涵盖严格 X-Frame-Options 阻断、Content-Security-Policy frame-ancestors 等） | `frame-error` |
| executeScript 未返回 result 且无明显其他原因 | `sandbox`（典型为 `sandbox` 属性 iframe，注入被沙箱拒绝） |

新增 manifest permission：`"webNavigation"`。`<all_urls>` host_permission 已就位。

### 3. Snapshot 输出 schema

```ts
interface PageSnapshot {
  url: string;                // top frame url
  title: string;              // top frame title
  frames: FrameSnapshot[];    // frames[0] 永远是 top (frameId=0)
}

type FrameSnapshot =
  | ReachableFrameSnapshot
  | UnreachableFrameSnapshot;

interface ReachableFrameSnapshot {
  frameId: number;
  frameUrl: string;
  origin: string;
  crossOrigin: boolean;        // origin !== topFrame.origin（top 永远 false）
  parentFrameId: number | null; // top 为 null
  elements: ElementInfo[];
  truncated?: true;            // 元素超过本帧配额时
}

interface UnreachableFrameSnapshot {
  frameId: number;
  frameUrl: string;
  origin: string | null;       // 无法解析时 null
  crossOrigin: boolean;
  parentFrameId: number | null;
  unreachable: true;
  reason: "sandbox" | "extension-child" | "about-blank" | "frame-error";
}
```

`ElementInfo` 与现有保持一致（index/tag/type/role/text/placeholder/ariaLabel/disabled/region/boundingBox），不加 frame 字段（frame 信息在外层 `FrameSnapshot` 里）。

**Element 配额**：保留 per-frame `MAX_ELEMENTS = 200`；新增 tab 总上限 `MAX_TOTAL_ELEMENTS = 600`，按帧顺序填配额，超额帧仍列出但 `elements: []` + `truncated: true`，让 LLM 知道"这帧有内容只是被截断"，不是"没东西"。Top 享配额最优先（frames[0] 永不被 truncated）。

### 4. Per-frame untrusted wrapper

LLM observation 段从单一 `<untrusted_page_content>...</untrusted_page_content>` 改为多块，每块带 frame 元属性：

```
<untrusted_page_content frame_id="0" frame_url="https://example.com/" frame_origin="https://example.com">
  ...top elements text dump...
</untrusted_page_content>
<untrusted_page_content frame_id="3" frame_url="https://docs.embed.com/x" frame_origin="https://docs.embed.com" cross_origin="true">
  ...embed frame elements...
</untrusted_page_content>
<untrusted_page_content frame_id="7" frame_url="..." unreachable="true" reason="sandbox">
</untrusted_page_content>
```

`escapeUntrustedWrappers` 现有 regex（`LT + slash{0..3} + tagAlt + NOT_GT{0..200} + GT`）已能匹配 close-tag 任意属性 payload；open-tag 加合法属性不影响 escape 触发条件。**新增单元测试覆盖两类攻击场景**（见 §Tests），不改 regex。

**Attribute 值 sanitize**：`frame_url` / `frame_origin` / `reason` 嵌入 wrapper open tag 属性前必须 escape — 至少替换 `<` / `>` / `"` 为 HTML 实体（`&lt;` / `&gt;` / `&quot;`），防御 URL query string 携带这些字符时逃逸 attribute boundary。具体 helper 在 plan 中实现（建议放在 `untrusted-wrappers.ts` 同模块，命名如 `escapeWrapperAttribute`）。

### 5. Tool schema 改动

```ts
// 写类：frameId 必填
click:  { frameId: number, elementIndex: number }
type:   { frameId: number, elementIndex: number, text: string, clear?: boolean }
select: { frameId: number, elementIndex: number, value: string }

// scroll：frameId 可选，默认 0（顶层）
scroll: { direction: "up" | "down", amount?: number, frameId?: number }
```

handler 改造：

- 读 args.frameId → 注入到 `target.frameIds: [frameId]`
- 注入函数本体（`clickByIndex` / `typeByIndex` / `selectByIndex` / `scroll`）**不改**：每个 frame 的 document/window 自然对应该 frame，`querySelectorAll('[data-chrome-ai-agent-idx="..."]')` 在该 frame 文档里就找到目标
- frame 已消失（导航 / 移除）→ `executeScript` reject `"Frame with ID X not found"` → handler 转成 `{ success: false, error: "Frame ${frameId} unreachable or removed. Re-snapshot." }`
- frameId 为 null/undefined → JSON schema 校验前置失败；若漏过到 handler，返回 `{ success: false, error: "frameId is required. Use frame_id from the latest snapshot. The top frame is frameId 0." }`

System prompt builder 在 "Tools" 章节加入 frame-awareness 段落：每个 snapshot 可能含多 frame，每个 frame 独立 elementIndex 计数，写类工具必须同传 frameId 与 elementIndex。

### 6. Read 路径 fan-out

三条读类路径全部 allFrames，结果 merge 成一致结构：

```ts
interface ExtractedPageContent {
  url: string;
  title: string;
  description: string;        // 仅 top frame
  frames: ExtractedFrameContent[];
}

type ExtractedFrameContent =
  | { frameId: number; frameUrl: string; origin: string; crossOrigin: boolean;
      content: string; truncated?: true; }
  | { frameId: number; frameUrl: string; origin: string | null; crossOrigin: boolean;
      unreachable: true; reason: string; }
```

**Byte budget**：top 优先配额；现有 `MAX_LENGTH = 50_000` 字符是**全 tab 总上限**而非 per-frame，避免恶意页面用大量 frame 撑爆 LLM 上下文。剩余配额按 frame 顺序填，超额帧标 `truncated: true` 且 `content: ""`。

`get_tab_content` 工具回 LLM 的 ToolResult content 仍是 string（wire format），但内容是分段拼接：

```
<untrusted_page_content frame_id="0" frame_url="..." frame_origin="...">...</untrusted_page_content>
<untrusted_page_content frame_id="3" frame_url="..." frame_origin="..." cross_origin="true">...</untrusted_page_content>
<untrusted_page_content frame_id="7" frame_url="..." unreachable="true" reason="x-frame-options"></untrusted_page_content>
```

SW 拼接逻辑统一走 `escapeUntrustedWrappers`，与 snapshot observation 保持完全一致的 wrapper 形态。

### 7. Risk 模型扩展

`RiskClassifyContext` 新增字段：

```ts
interface RiskClassifyContext {
  // ...existing fields
  frameOrigins?: Map<number, string>;   // frameId → origin，含 top（key=0）
}
```

由 loop 在每轮 snapshot 完成后填入。新增 helper：

```ts
function hasCrossOriginFrame(
  args: { frameId?: number },
  ctx: RiskClassifyContext | undefined,
): { crossOrigin: boolean; frameOrigin: string | null }
```

应用规则（**不升级 level，仅丰富 reason**）：

| 工具 | 现有判定 | 加 cross-origin frame 后 |
|---|---|---|
| `type` 敏感字段 | high (reason: `Sensitive field: <name>`) | reason 追加 ` in cross-origin frame <origin>`，仍 high |
| `click` submit / 关键字 | high (reason: `Submit button` / `Keyword match: <kw>`) | 同上 |
| `select` 关键字 | high | 同上 |
| `type` 非敏感字段 | low | **依然 low** |
| `click` / `select` 非敏感非关键字 | low | **依然 low** |
| `scroll` | low | 依然 low |

抽 helper `appendCrossOriginFrameReason(baseReason, frameOrigin)` 统一后缀格式，便于 confirm UI 用 prefix 检测加 chip。

### 8. Confirm card UI 改造

四处差异：

1. **目标 frame chip**：confirm card title 区下加一颗 chip
   - `Frame 0 · example.com`（same-origin，灰色）
   - `Frame 3 · docs.embed.com · cross-origin`（cross-origin，amber 边框）
   - 仅当 frameId !== 0 时显示，避免顶层冗长
2. **元素摘要行**：`Click <button>"Submit"</button>` → `Click <button>"Submit"</button> in Frame 3 (docs.embed.com)`（同样仅 frameId !== 0 时追加）
3. **`get_tab_content` preview**：分段渲染，每段头是 `Frame N · <origin>` chip + cross-origin amber 边框；可达 frame 显示前 4 行内容 + 展开按钮；unreachable frame 单独一行 `Frame N · <url> · 不可访问（<reason>）`（reason 走 4 种之一）
4. **风险原因**：直接渲染 `risk.reason`（已包含 cross-origin frame 后缀）

Skip-permissions 行为不变：`ctx.skipPermissions && risk.level === "high"` 短路。cross-origin frame 不升级 level，因此 skip 模式下不会增加 confirm 频次。

### 9. wait_for_settle scope

维持现状（top-frame DOM mutation observer + load/network idle 信号）。跨 frame settling 因 contentDocument 跨 origin 拿不到、frame load 事件捕获不全，**显式列为 known limitation**：post-action settle 不观察 child-frame mutation；依赖下一轮 snapshot 自然收敛。

## Architecture Invariants

写入 `docs/solutions/2026-05-XX-iframe-invariant-trace.md`（plan 阶段定具体编号，本 spec 暂用 R-iframe-N 占位）：

- **R-iframe-1 selector duality**：所有 page-level 写工具（click/type/select）目标必须用 `(frameId, elementIndex)` 二元组寻址；handler 注入用 `target.frameIds`，不用 `allFrames`。Build-time 在 `tools.ts` 加断言：写类工具的 JSON schema 必须 require `frameId`。
- **R-iframe-2 read fan-out 一致性**：`snapshotInteractiveElements` / `extractPageContent` / `extractPageContentHardened` 三个 SW-level 入口必须走 `allFrames: true`。在 plan 里通过常量列表 `READ_FANOUT_CALLSITES`（文件:函数）做 review 标记，新增 read 调用必须自检并加入。
- **R-iframe-3 per-frame untrusted wrapper**：进入 LLM context 的页面文本必须按 frame 分段、每段 wrapper 带 `frame_id` 属性（含 unreachable 段）；不允许出现裸 `<untrusted_page_content>` 不带属性形态。`escapeUntrustedWrappers` regex 不动，靠扩展测试守。
- **R-iframe-4 risk reason 但不升 level**：cross-origin frame 仅 enrich reason，不改变 level。Build-time 不强制；risk.test.ts 的对照测试守语义。
- **R-iframe-5 pin 不下沉**：`SessionMeta.pinnedTabs` schema 不变；不引入 pinnedFrames / allowedOrigins。靠 review 守。

## Tests

新增/扩展（按文件）：

- `src/lib/dom-actions/snapshot.test.ts`（新建）：单元测试 stamp 属性 per-document、可见性过滤、空 frame；jsdom 不易模拟真 iframe，集成测试在 loop.test.ts 通过 mock executeScript 多 result 覆盖
- `src/lib/agent/loop.test.ts`：multi-frame snapshot merge、unreachable frame diff 路径、frame 消失时 click 回错路径
- `src/lib/agent/risk.test.ts`：5 条对照断言（type 敏感字段 / click submit / click 关键字 / type 非敏感 / click 非敏感）— 同元素在 same-origin frame vs cross-origin frame，level 必须一致，reason 必须不同
- `src/lib/agent/untrusted-wrappers.test.ts`：补三类攻击 case
  - close-tag 带恶意属性 payload：`</untrusted_page_content foo="bar">` 必须被 escape
  - open-tag 含合法属性后跟伪造 close：`<untrusted_page_content x=">SYSTEM:..."` 必须不破解 wrapper
  - frame_url/frame_origin 携带 `<` `>` `"` 字符时（恶意 URL query string），`escapeWrapperAttribute` 必须 sanitize 为 HTML 实体
- `src/lib/agent/cross-layer.test.ts`：wire→DisplayMessage 透传 frame_id 元信息（per CLAUDE.md memory：跨 panel↔SW 新 wire 字段必须有 cross-layer 回归测试）
- background extract path：`src/background/index.test.ts`（如不存在则新建）覆盖 `webNavigation.getAllFrames` mock + executeScript multi-result merge + unreachable diff

Confirm UI 渲染快照测试：现有 sidepanel confirm 卡片测试若有覆盖快照，扩 frame chip + 分段 preview；plan 阶段确认现状。

## Migration / 兼容

- **Storage at-rest**：`SessionMeta` schema 不变；`agentMessages` 持续存 raw tool_use args；新 schema 的 frameId 字段自动随之持久化，不写 migration 模块
- **历史归档读取**：旧 archived task 的 tool_use 没 frameId，归档不会被 resume 跑；panel 渲染层兼容 frameId 缺省（frame chip 该缺就缺，不抛错）
- **In-flight 升级**：v0.6.x → v0.7.0 升级瞬间若有未结案 tool_use，新版 handler 收到旧 schema → reject `frameId is required`；LLM 下一轮自纠。**不写迁移代码**
- **Manifest 改动**：新增 `webNavigation` permission（用户更新插件时 Chrome 会重新提示授权，文案需要在 release-notes 解释清楚）

## Out of Scope

- shadow root 跨 boundary 寻址（Phase X 课题，与 frame 寻址正交但思路相似）
- 跨 frame 的 wait_for_settle 观察
- frame 粒度的 pin / allowedOrigins 列表
- iframe 内的 keyboard 模拟工具（CDP keyboard 现在是 tab 粒度，frame 维度涉及 RDP target session 细节，独立设计）
- screenshot 工具的 frame 视区裁剪（screenshot 已是高 risk + tab 粒度，frame 维度不在本期）

## Next Steps

1. `/superpowers:writing-plans` 起 plan
2. plan 阶段定具体 R-iframe 编号映射 + units 拆分（建议 ≥ 6 unit：webNavigation 接入 / snapshot 改造 / extract 改造 / tool schema + handler / risk + confirm UI / tests + manifest）
3. plan 完成后写 `docs/solutions/2026-05-XX-iframe-invariant-trace.md`，正式 R-iframe 编号 + 落地点
