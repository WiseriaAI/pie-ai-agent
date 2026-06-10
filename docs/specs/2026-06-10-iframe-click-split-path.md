# iframe Click 支持 — 分路径设计（顶层 CDP / 子 frame 合成点击）

- **日期**: 2026-06-10
- **状态**: implemented (2026-06-10)
- **前置**: issue #42 (iframe page awareness, v0.9.0) / issue #81 (hover + CDP click upgrade)
- **关联回归**: click/hover 在 iframe 内报 `Internal: frame mapping failed for frameId X`

## 1. 背景

#42 落地时 click 是 frame 内合成点击（`executeScript` + `frameIds` 直接派发），iframe 天然支持、无坐标问题。#81 出于两个动机把 click/hover 升级为 CDP 真实鼠标事件：(1) hover 触发的 UI 需要真实 `mouseMoved`；(2) 反爬站点校验 `event.isTrusted`。升级后 iframe 场景从"frame 内派发"变为"必须算出顶层视口坐标"，依赖 `geometry.ts` 的 chrome↔CDP frame 映射（`Page.getFrameTree` + URL 启发式匹配）+ `DOM.getBoxModel`。

断点在映射：site isolation 下跨域 iframe（OOPIF）是独立 CDP target，根 session 的 `Page.getFrameTree` 看不全其节点；URL 启发式在 `about:blank`/`srcdoc`/frame 导航后也会失配。真机表现：`click({frameId: 21114, elementIndex: 49})` → `Internal: frame mapping failed`。**这是 #81 的隐性回归**——之前 iframe 内 click 一直可用。

核心洞察：**感知与操作共享注入前提**。`read_page` 能看见某 frame 的元素，意味着 `executeScript` 能注入该 frame——那么点击也可以在 frame 内完成，根本不需要顶层坐标。CDP 真实事件的增量价值（isTrusted、user activation）集中在顶层主流程；为 iframe 内的低频点击维护一整套跨 frame 几何，成本收益不成立。

## 2. 目标 / 非目标

**目标**：

1. 凡是 `read_page` 能感知到的 frame 内元素，click 都能命中（含跨域 OOPIF、嵌套多层）；
2. 顶层 frame 的 click/hover 行为零变化（保住 #81 的 isTrusted / user activation / hover 收益）；
3. 删除 chrome↔CDP frame 映射整套启发式（净复杂度下降）；
4. snapshot 补采 `aria-haspopup` / `aria-expanded`，给 LLM 提供"该元素会展开子内容"的弱信号。

**非目标**（显式不做）：

- **iframe 内 hover**：合成 mouseover 触发不了 CSS `:hover` 和多数 JS 菜单，无等价降级；学 editor CDP 支持先例（v1 顶层限定），子 frame 明确报错。真实需求出现后再启动 postMessage 会合几何方案（见 §7 备选记录）。
- **iframe 内 isTrusted 点击**：合成点击在校验 isTrusted 的 iframe（如 CAPTCHA 框）内无效——现状是直接报错，不回归；observation 诚实标注供 LLM 换路。
- **hover 触发检测**：CSS `:hover` 规则扫描（跨域样式表 SecurityError + 误报）与 listener 枚举（框架根委托不可用）都不可靠，不做；只补 aria 弱信号，判断交给 LLM。
- sandboxed iframe（无 allow-scripts）：注入被拒 → 明确报错。`read_page` 同样看不见这类 frame，LLM 实际不会对其发 click。

## 3. 设计

### 3.1 click 分路径

`click` 的 tool schema 不变（`(frameId, elementIndex)` required，R-iframe-1 守住），handler 内部分流：

- **`frameId === 0`**：现有 CDP 路径原样保留——consent gate → acquireSession → `elementToPagePoint` → `Input.dispatchMouseEvent` 三连。
- **`frameId > 0`**：`executeScript({target: {tabId, frameIds: [frameId]}, func: actByIdxInjected, args: [{op: "click", idx}]})`。**不走 CDP gate、不 attach、无坐标换算**。frame 不存在时 `executeScript` 抛错 → 映射为现有 `Frame ${frameId} unreachable or removed. Re-snapshot.` 文案。

观察文案（synthetic 路径）：

```
Clicked [${idx}] in frame ${frameId} via synthetic events (real mouse input
is top-frame only). If the page did not react, the control may require
trusted input — report via fail if no alternative exists.
```

附带行为变化（正向）：纯 iframe 点击任务不再触发 CDP attach——无"已开始调试"黄条、无首次授权卡。

### 3.2 act-core 新增 `click` op

`actByIdxInjected` 增加 `{op: "click"; idx: number}`，与现存 `focusClick`（keyboard 聚焦用的裸 `el.click()`）区分：

1. `scrollIntoViewIfNeeded({block: "center"})`（行为与 CDP 路径的 rect 步对齐）；
2. 完整事件序列模拟真实点击的可观察形态：`pointerover` → `pointerdown` → `mousedown` → `focus()` → `pointerup` → `mouseup` → `click`（均 `bubbles: true, cancelable: true, composed: true`，坐标取元素中心）；
3. 复用 `findByIdxDeep` 定位（shadow DOM 穿透，与其他 op 一致）；
4. 返回 `{ok: true, op: "click", observation}`。

`focusClick` 保持原样不动（keyboard 工具语义不同：只为聚焦，不模拟完整点击）。

### 3.3 hover 顶层限定

`hover` handler 开头：`frameId !== 0` → 直接返回（不 attach CDP）：

```
hover is only supported in the top frame for now. For elements inside
iframes, try clicking directly, or use read_page to check whether the
target is already visible.
```

schema 与描述同步更新（描述注明 top-frame only）。

### 3.4 geometry.ts 瘦身

click/hover 都只在 `frameId === 0` 时走 `elementToPagePoint`，因此：

- `elementToPagePoint` 删去 `frameId > 0` 分支、`frameId` 与 `cdpSession` 参数（签名收缩为 `(tabId, elementIndex)`，注入 target 固定 `frameIds: [0]`；两处调用方在同文件内已显式 `frameId === 0` 分流，无需防御参数）；
- 删除 `resolveChromeToCdpFrameId`、`CdpFrameTreeNode`、`CdpFrame`、`ChromeFrame` 及对应测试；
- `GeometryError` 缩减为 `element-not-found` / `element-not-visible`（`frame-gone` 移到 click handler 的 executeScript 错误映射；`cdp-frame-id-unresolved` 删除）。`geometryErrorToActionResult` 的 exhaustiveness check 在编译期强制完成映射收缩。

### 3.5 snapshot 补采 aria 线索

`probe-core.ts` 的 interactive 元素属性采集白名单加 `aria-haspopup` 与 `aria-expanded`（具体落点在 plan 阶段对照现有属性管道确认，含 interactive-parity 约束）。渲染进 `<interactive_index>` 行属性，LLM 可据此决定先 hover（顶层）或直接 click。

### 3.6 tool description 更新

- `click`：补一句 iframe 行为说明（子 frame 走 synthetic events，绝大多数站点等效）；
- `hover`：USE WHEN 区注明 top-frame only，子 frame 场景建议直接 click 或 read_page 复查。

## 4. 文件变更

| 文件 | 变更 |
|---|---|
| `src/lib/dom-actions/act-core.ts` | 新增 `click` op（§3.2） |
| `src/lib/agent/tools/mouse.ts` | click 分路径（§3.1）；hover 顶层限定（§3.3）；错误映射收缩 |
| `src/lib/dom-actions/geometry.ts` | 瘦身（§3.4），删映射启发式 |
| `src/lib/dom-actions/probe-core.ts`（或属性管道实际落点） | aria-haspopup / aria-expanded 采集（§3.5） |
| `src/lib/dom-actions/act-core.test.ts` | click op 单测（事件序列、shadow DOM、scrollIntoView） |
| `src/lib/agent/tools/mouse.test.ts` | 分路径行为：frameId>0 不 attach CDP、不弹 consent；hover 子 frame 报错 |
| `src/lib/dom-actions/geometry.test.ts` | 删映射用例，保留顶层 rect 用例 |
| `src/__tests__/cross-layer/click-cdp-failure-modes.test.ts` | 删 `cdp-frame-id-unresolved` case；补 iframe synthetic 路径 case |
| `docs/solutions/2026-05-12-iframe-invariant-trace.md` | 更新：R-iframe-2 的 `frame-discovery.ts` 引用已随 PR #152/#159 失效；本次几何链变更一并修正映射 |

不变：click/hover tool schema（R-iframe-1）、CdpSession、type/select/keyboard/editor 全部、read 侧 fanout。

## 5. 错误模型汇总

| 场景 | 表现 |
|---|---|
| frameId>0，frame 已关闭/导航走 | `Frame ${frameId} unreachable or removed. Re-snapshot.`（executeScript 错误映射，与 type/select 现状一致） |
| frameId>0，元素不在 | act-core 现有 `Element not found at index N...` |
| frameId>0，sandboxed 注入被拒 | executeScript 抛错透传为明确错误 |
| frameId>0 的 hover | §3.3 固定文案，不 attach CDP |
| frameId 0 全路径 | 零变化 |

## 6. 验证

单测 + cross-layer 见 §4。真机 checklist：

1. 同域 iframe 内按钮 click 命中；
2. 跨域 OOPIF（第三方评论框 / embed 播放器）click 命中——本次回归场景；
3. iframe 套 iframe（双层）click 命中；
4. iframe 滚出顶层视口 → click 仍命中（frame 内 scrollIntoView 足够，无需顶层坐标）；
5. `srcdoc` 子 frame click 命中（旧 URL 启发式断点）；
6. 纯 iframe 点击任务全程无 CDP 黄条 / 授权卡；
7. hover 子 frame → 固定报错且 LLM 能继续；
8. 顶层 click/hover 无回归（含 hover 出菜单后接 click）；
9. `aria-haspopup` 元素在 read_page 输出中可见。

## 7. 备选方案记录（已否决/缓议）

- **postMessage 会合几何**（让 CDP 真实点击在 iframe 拿到正确顶层坐标，连带支持 iframe 内 hover）：设计已完成评审但缓议——iframe 内 hover/isTrusted 点击需求未被真机证实，工程量 3-5 天 + 注入时序风险，等需求出现再启动。要点：沿 `webNavigation` parent 链逐跳 postMessage(token+序号) 会合定位 iframe 元素 → 累加 content-box 原点；全链滚动完成后再读 rect；token 随机 + 首命中语义。
- **全合成 click（含顶层）**：否决——顶层 CDP click 的 isTrusted / user activation（弹窗、剪贴板）收益真实存在且已稳定运行，整体退回是确定的回归。
- **修 CDP 映射（nonce + OOPIF `Target.setAutoAttach` 多 session）**：否决——CdpSession 生命周期改造成本是分路径方案数倍，收益边缘。
