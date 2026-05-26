# Hover Support + CDP Click Upgrade — Design

> 状态：spec / brainstorm 阶段
> 日期：2026-05-26
> 作者：wenkang
> 相关 issue：TBD（待创建）

## 1. 背景与动机

当前 Agent 的 DOM 交互工具集（`click` / `type` / `select` / `scroll`）通过 `chrome.scripting.executeScript` 注入函数实现。`click` 调用 `(el as HTMLElement).click()` —— 这是 JS 层合成 click，**不触发任何 `mouseover` / `mouseenter` 事件**，也带 `event.isTrusted === false`。

这导致两类站点 Agent 无法操作：

1. **Hover-triggered UI**：很多现代站点（电商分类导航、SaaS 工具栏、社交媒体头像菜单）只在鼠标 hover 时展示子菜单/操作按钮。Agent 没有 hover 工具，子菜单永远不会出现在 `read_page` snapshot 里。
2. **反爬 / 严格站点**：部分站点会校验 `event.isTrusted`，对合成 click 直接拒绝（支付、登录、风控敏感操作）。

本设计补 `hover` 工具，同时把 `click` 从 `executeScript` 合成事件升级为 CDP `Input.dispatchMouseEvent`（真实鼠标事件）。

## 2. 目标 / 非目标

### 目标
- 新增 `hover` 工具，触发真实 `mouseMoved` CDP 事件
- `click` 升级为 CDP `mouseMoved → mousePressed → mouseReleased` 序列，行为统一
- iframe 内元素的 hover/click 通过 CDP `DOM.getBoxModel` 累加几何，跨域 iframe 也支持
- CDP 默认能力：首次调用 hover/click/keyboard 时 inline 引导卡片询问用户同意，一次同意覆盖所有 CDP 工具
- CDP 不可用时 fail-fast 返回错误，agent 自行响应

### 非目标
- 双击 / 右键 / 中键 / drag
- 鼠标轨迹模拟（贝塞尔曲线）
- Per-tab / per-host CDP 白名单
- Hover-and-click 合并工具
- 真实浏览器 e2e 测试

## 3. 用户故事

1. **U1（hover-only 菜单）**：用户让 Agent "把购物车里的商品全部删掉"。Amazon 的 cart 操作藏在 hover 弹出的子菜单里。Agent hover 商品行 → read_page → 发现 "Delete" → click。
2. **U2（反爬站点）**：用户让 Agent "在 X 网站点登录"。该站校验 `isTrusted`。Agent 用 CDP click 触发真实事件 → 登录流程开始。
3. **U3（首次使用）**：新用户装上扩展，第一次让 Agent 点东西。Agent 调 click → sidepanel 弹出引导卡片说明 CDP 用途和黄条提示 → 用户点启用 → click 完成。
4. **U4（拒绝 / 后悔）**：用户首次引导时点不启用。后续想用时去 Settings 打开开关。
5. **U5（DevTools 冲突）**：用户开着 DevTools 调试自家 web app，让 Agent 点东西。Agent 收到 cdp-attach-conflict 错误，停止并提示用户关闭 DevTools。

## 4. 架构

### 4.1 文件结构

**新增**
- `src/lib/dom-actions/geometry.ts` — `elementToPagePoint(tabId, frameId, idx)` + iframe 偏移累加 helper
- `src/lib/agent/tools/mouse.ts` — `hover` / `click` handler + 内部 `dispatchMouseAt` helper + `requireCdpInput` helper
- `src/lib/cdp-input-enabled.ts` — 替代 `keyboard-simulation.ts`，三态 storage flag
- `src/lib/cdp-input-onboarding.ts` — SW 侧引导 request/response 协调（port 协议）

**修改**
- `src/lib/agent/tools.ts` — `click` handler 改指 `mouse.ts`；注册 `hover`
- `src/lib/agent/tool-names.ts` — `hover` 进 write 集合
- `src/lib/agent/loop.ts` — `keyboardSimEnabled` 引用改 `isCdpInputEnabled`
- `src/background/index.ts` — storage listener 监听新 key；启动时迁移旧 key
- `src/sidepanel/components/Settings.tsx` — toggle label "Browser input simulation (CDP)"，三态显示
- `src/sidepanel/components/CdpOnboardingCard.tsx`（新组件）— 引导卡片 UI

**删除**
- `src/lib/dom-actions/click.ts`（整文件）
- `src/lib/keyboard-simulation.ts`（被 `cdp-input-enabled.ts` 替代；一次性迁移逻辑放在新文件）
- `src/lib/dom-actions/index.ts` 的 `clickByIndex` export

### 4.2 调用链

```
Agent 调 hover(frameId, elementIndex)
    ↓
tools.ts:hover.handler → requireCdpInput(ctx)
    ↓ flag 三态判定
    ├─ undefined → onboarding flow (4.4) → 用户答启用 → 写 true → 继续
    ├─ true       → 直接继续
    └─ false      → return {success: false, error: 'cdp-disabled'}
    ↓
acquireCdpSession(tabId, ownerToken) → CdpSession
    ↓
elementToPagePoint(tabId, frameId, elementIndex) → {x, y}
    ├─ executeScript({frameId}, readRectByIdx) → frame-local rect
    ├─ frameId === 0 → 直接返回 rect center
    └─ frameId > 0  → CDP DOM.getNodeForFrameOwner + DOM.getBoxModel → page-level quad → 加 frame-local rect center
    ↓
session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y, button: 'none', clickCount: 0})
    ↓
withActionSettle(tabId, ...) settle window
    ↓
return {success: true, observation: 'Hovered [idx]: <tag> "label". Call read_page to see revealed elements.'}
```

`click` 链路同上，最后多两条 `Input.dispatchMouseEvent` (`mousePressed` + `mouseReleased`)。

### 4.3 几何核心：`elementToPagePoint`

```ts
// src/lib/dom-actions/geometry.ts
export async function elementToPagePoint(
  tabId: number,
  frameId: number,
  elementIndex: number,
): Promise<{x: number; y: number} | GeometryError> {
  // Step 1: 在目标 frame 读 rect
  const [{ result: localRect }] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: readRectByIdx,
    args: [elementIndex],
  });
  if (!localRect) return { kind: 'element-not-found', index: elementIndex };
  if (localRect.w <= 0 || localRect.h <= 0) return { kind: 'element-not-visible', index: elementIndex };

  const centerLocal = { x: localRect.x + localRect.w / 2, y: localRect.y + localRect.h / 2 };
  if (frameId === 0) return centerLocal;

  // Step 2: chrome frameId → CDP frameId（url + DOM-order 兜底）
  const cdpFrameId = await resolveChromeToCdpFrameId(tabId, frameId);
  if (!cdpFrameId) return { kind: 'cdp-frame-id-unresolved', frameId };

  // Step 3: 父 frame 内 <iframe> 元素的 page-level quad
  const session = getSessionByTabId(tabId);
  const { nodeId } = await session.send('DOM.getNodeForFrameOwner', { frameId: cdpFrameId });
  const { model } = await session.send('DOM.getBoxModel', { nodeId });
  // model.content = [x1,y1, x2,y2, x3,y3, x4,y4] page-level
  const iframeOriginX = model.content[0];
  const iframeOriginY = model.content[1];

  return { x: iframeOriginX + centerLocal.x, y: iframeOriginY + centerLocal.y };
}

function readRectByIdx(idx: number) {
  const el = document.querySelector(`[data-pie-idx="${idx}"]`);
  if (!el) return null;
  el.scrollIntoViewIfNeeded?.({ block: 'center' });
  // 等一个 rAF 让 layout 稳
  return new Promise(r => requestAnimationFrame(() => {
    const r2 = el.getBoundingClientRect();
    r({ x: r2.x, y: r2.y, w: r2.width, h: r2.height });
  }));
}
```

跨域 iframe 在 CDP `DOM.getBoxModel` 调用上**不受 same-origin policy 限制**——CDP 在浏览器 process 内访问 layout 树。这是 CDP 路径相对 `executeScript` 路径的核心优势。

### 4.4 CDP 引导流程

**Storage flag**: `chrome.storage.local.cdp_input_enabled` (`undefined | true | false`)

**触发路径**:
1. tool handler 入口 `requireCdpInput(ctx)`
2. 读 flag：`undefined` → 进引导；`true` → 通过；`false` → 返回 cdp-disabled error
3. 引导：SW 通过 chat-stream port 发 `{kind: 'cdp-onboarding-request', sessionId}` → sidepanel 显示 `CdpOnboardingCard` → 用户答启用/不启用 → sidepanel 回 `{kind: 'cdp-onboarding-response', enabled: bool}` → SW 写 flag → handler 继续 / 返回 error

**Sidepanel UI 文案**：
> **Pie 需要启用浏览器输入模拟（CDP）**
>
> 现代网站很多按钮和菜单只对真实鼠标事件响应。启用后 Pie 用 Chrome 的调试接口模拟真实鼠标移动和点击。
>
> 启用期间标签页顶部会出现「Pie 已开始调试此浏览器」的黄条——这是 Chrome 强制提示，无法关闭。任务结束自动解除。
>
> [启用]   [不启用]

**并发**:
- 多 sidepanel 各自卡片，互不干扰
- A 等待中、B 同意 → storage change → sidepanel A 监听 storage，自动关卡片并 resolve = true
- A 拒绝、B 同意：last-write-wins

**Sidepanel 关闭中途**:
- Port disconnect → SW `requireCdpInput` 收到 disconnect → 返回 `{success: false, error: 'Onboarding cancelled (panel closed)'}`

**老用户迁移**:
- SW `onInstalled` / `onStartup`:
  - 读 `keyboard_simulation_enabled`
  - `true` → 写 `cdp_input_enabled = true`，删旧 key
  - `false` → 写 `cdp_input_enabled = false`，删旧 key
  - `undefined` → 不动新旧 key

## 5. 工具接口

### 5.1 `hover`

```ts
{
  name: "hover",
  description: "Hover the mouse over an element by its data-pie-idx from the most recent read_page. Use this when an element shows new content on mouseover (dropdown menus, tooltips, hover cards). After hovering, call read_page again to see any newly revealed elements.",
  parameters: {
    type: "object",
    properties: {
      frameId:      { type: "number", description: "Frame ID from latest read_page." },
      elementIndex: { type: "number", description: "data-pie-idx of the element." },
    },
    required: ["frameId", "elementIndex"],
    additionalProperties: false,
  },
}
```

**返回**: `{success: true, observation: 'Hovered [idx]: <tag> "label" (scrolled into view). Call read_page to see revealed elements.'}` 或 6 节中的任一错误。

### 5.2 `click`（接口不变）

签名保持 `{frameId, elementIndex}`。内部实现从 `executeScript(clickByIndex)` 改为 CDP 三连：

```
session.send('Input.dispatchMouseEvent', {type: 'mouseMoved',    x, y, button: 'none', clickCount: 0});
session.send('Input.dispatchMouseEvent', {type: 'mousePressed',  x, y, button: 'left', clickCount: 1});
session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
```

显式发 `mouseMoved` 是为了触发 hover-then-enable 类按钮的可点击状态。

## 6. 错误模式（fail-fast）

| kind | 触发 | error 文案 | agent 期望响应 |
|---|---|---|---|
| `element-not-found` | `[data-pie-idx="N"]` 找不到 | `'Element not found at index N. Page changed; call read_page again.'` | 调 read_page |
| `element-not-visible` | rect.w / rect.h ≤ 0 | `'Element [N] has zero size. Call read_page again.'` | 调 read_page |
| `frame-gone` | executeScript frame error | `'Frame N unreachable; re-snapshot.'` | 调 read_page |
| `cdp-disabled` | flag === false | `'CDP input is disabled in Settings. Cannot click/hover.'` | stop / 报用户 |
| `cdp-attach-conflict` | DevTools 占用 / 跨 session 占用 | `'CDP attach failed: another debugger is attached (DevTools or another agent task). Close it and retry.'` | stop / 报用户 |
| `cdp-detached-midway` | 黄条 cancel / target gone | 复用 loop.ts abort 路径，不走 ActionResult | task aborts |
| `cdp-frame-id-unresolved` | chrome→CDP frameId 映射失败 | `'Internal: frame mapping failed. Try in top frame.'` | stop / 报 bug |
| `onboarding-cancelled` | sidepanel 中途关闭 | `'Onboarding cancelled (panel closed).'` | stop |

## 7. 不变量

1. **R-iframe-1 扩展**: `hover` 进 `tool-names.ts` write 集合；`tools.ts` schema 强制 `required.includes("frameId")`（已有 build-time check 覆盖）
2. **R-cdp-1（新增）**: 所有 CDP 工具（hover / click / dispatch_keyboard_input / press_key）通过 `requireCdpInput(ctx)` helper 路由；不允许 handler 直接调 `acquireCdpSession`。用 cross-layer test 守护（grep + assert）
3. **R7 cross-session lock 扩展**: hover 在 write 集合内 → 自动进 R7 锁覆盖（已有机制）

## 8. 测试策略

### 单元测试
- `geometry.test.ts`: top frame / 同源 iframe / 深嵌套 / 跨域 iframe / 0×0 / not found
- `mouse.test.ts`: hover 1 个 mouseMoved；click 3 连；8 类错误形态
- `cdp-input-enabled.test.ts`: 三态、storage change、迁移
- `cdp-input-onboarding.test.ts`: request/response 协议、并发独立、用户答启用/拒绝、disconnect 取消

### Cross-layer 测试
- `hover-then-read-page-roundtrip.test.ts`
- `cdp-tools-routing.test.ts`（R-cdp-1 不变量守护）
- `click-cdp-failure-modes.test.ts`
- `cdp-input-consent-gating.test.ts`

### 删除
- `src/lib/dom-actions/click.test.ts`（若有）

### 改名/重写
- `src/lib/agent/tools/keyboard.test.ts` 内引用 `keyboard-simulation` 的部分改 `cdp-input-enabled`

### 手测 checklist（PR 附）
1. 全新 profile → 首次 click 触发引导 → 启用 → 黄条出现 → click 完成
2. 拒绝引导 → click 报 cdp-disabled → Settings 看到 toggle 关
3. Amazon nav hover → 子菜单展开 → read_page → click
4. iframe 内 click（嵌 YouTube 的页面）
5. DevTools 占用 → cdp-attach-conflict → 关 DevTools → 重试通过
6. 黄条 Cancel → task abort 正常
7. 旧版 keyboard sim 开启 → 升级后无引导，click 立即可用

## 9. YAGNI（显式不做）

- ❌ `hover(duration)` 参数
- ❌ 双击 / 右键 / 中键 / drag
- ❌ 鼠标轨迹模拟
- ❌ Hover-and-click 合并工具
- ❌ 自定义引导 timeout
- ❌ Per-tab / per-host CDP enable
- ❌ 真实浏览器 e2e
- ❌ 性能 SLO / 基准测试

## 10. 性能预期

| 操作 | 现状 | CDP 后 |
|---|---|---|
| click | <5ms（同进程 el.click）| 50–150ms（3 CDP RTT + 几何）|
| hover | n/a | 30–80ms（1 CDP RTT + 几何）|

Agent ReAct 单轮 LLM call 在秒级，工具调用从 5ms 升到 150ms 在总耗时里看不到。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Chrome 黄条惊吓首次用户 | inline 引导卡片提前告知 + Settings 旁说明 |
| DevTools 用户冲突 | cdp-attach-conflict 错误文案明确指导关闭 DevTools |
| 跨域 iframe frameId 映射边缘场景失败 | cdp-frame-id-unresolved 错误返回；agent 可降级到 top frame 操作 |
| 老用户升级被引导烦扰 | 迁移逻辑把已开的 keyboard sim 转成已开的 CDP input，无需再问 |
| 性能 10–30× 慢化 | 绝对值仍 <200ms，可接受 |

## 12. 后续可能扩展（不在本设计范围）

- 双击 / 右键 / drag 工具
- 反爬场景鼠标轨迹模拟
- Per-host CDP 白名单（如果用户大量拒绝引导但仍想用部分站点）
- Hover prompt 教学（在 system prompt 中明确指导何时 hover）
