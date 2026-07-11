# Pie IP 状态动画植入 Side Panel — Design Spec

- 日期：2026-07-11
- 来源：claude.ai/design 项目 `Pie IP 定稿.dc.html`（project `09d533f5-2709-4ecf-9d1f-e308b72d5ab7`）。本 spec 已内嵌全部动画参数，实现时**不需要**再访问设计稿。
- 状态：已与用户对齐（落点 = assistant 消息头 / 底部指示行；历史静止；success 播 2.5s 收尾）

## 目标

把定稿的 Pie IP（同心圆深色框 + 白饼 + 眼睛表情，全程单色）作为状态化形象植入 side panel Chat 界面：

1. 打开空会话 → 主 chat 区域大 IP 播「唤醒」（图标睁眼 morph），随后待命呼吸
2. 用户输入内容 → 「聆听」
3. 模型思考（thinking 流）→ 「思考」
4. 模型输出正文 / 调用工具 → 「执行」
5. 任务成功完成 → 「完成」播 ~2.5s 后归于静止

## 方案（已选定）

纯 CSS keyframes 直译成一个 React 组件（设计稿本身即 inline-style + keyframes 的 React 代码）。零新依赖；颜色接现有 token；`index.css` 已有全局 `prefers-reduced-motion` 兜底（所有 animation 塌缩成静止帧），无障碍免费。否决 Lottie/GIF 导出（新增依赖 + 资产管线，无收益）。

## 组件：`src/sidepanel/components/PieFace.tsx`

```tsx
<PieFace state={...} size={...} />
// state: "wake" | "idle" | "listening" | "thinking" | "working" | "success" | "static"
// size: px（正方形边长）
```

- 唯一新组件。无内部状态（`wake` 播完的切换由父层负责，见「空态」）。
- `static`：白脸 + 两只圆眼，无任何 animation——历史消息头用。
- `greeting`（招呼态）**不实现**：五个场景没有它的位置，不留 dead code。
- 设计稿的「反向播放退场（IP 收回成图标）」**不做**：无对应触发场景（YAGNI）。

### 颜色

| 元素 | 颜色 | 说明 |
|---|---|---|
| 深色外框（shell） | `#14181D` 固定 | 品牌固有色，**不随主题反转**（与 app icon 同理） |
| 白饼（disc）/ 眼睛底色 | `#FAFBFC` 固定 | 同上 |
| 眼睛/点（feature） | `#14181D` 固定 | 同上 |
| shell 内描边 | `inset 0 0 0 1px rgba(255,255,255,.05)` | 直译 |
| 扫描环 / 声波 / 完成光环 | `var(--c-accent)` | dark 下 = 设计稿 `#B8C8D6`，light 下自动石板蓝 |

### 几何（直译设计稿，`size` 为组件边长）

- disc（白饼）直径 = `size * 0.84`，居中；shell 占满 `inset: 0`，圆形。
- 身体动画组 `transform-origin: 50% 64%`。
- 眼睛容器绝对定位：`left 50%`，`top 45%`（thinking 为 `48%`），`translate(-50%,-50%)`。
- 眼睛（d = disc 直径）：

| state | 单眼尺寸 | 圆角 | 双眼间距 |
|---|---|---|---|
| idle / wake / static | `0.15d` 圆 | 50% | `0.17d` |
| listening | `0.175d` 圆 | 50% | `0.17d` |
| working（眯眼横条） | `0.20d × 0.075d` | `0.045d` | `0.17d` |
| success（弯月眼） | `0.185d × 0.11d` | `d d 0 0`（上圆下平） | `0.17d` |
| thinking（三点） | 每点 `0.13d` 圆 | 50% | `0.11d` |

- working 外圈扫描环：直径 `size * 0.98`，SVG circle `r = 直径/2 - 3`，`stroke-width 2.4`，`stroke-linecap round`，`stroke-dasharray = 26% 周长`。
- listening 声波：2 个同心圆环，直径 = d，`border: 2px solid accent`，错峰（第二个延迟半周期）。
- success 光环：1 个圆环，直径 = d，`border: 2.4px solid accent`。

### Keyframes（加入 `index.css` 现有 Motion 区块，前缀 `pie-`）

缓动 `EE = cubic-bezier(0.32,0.72,0,1)`（即现有 token `--ease-standard`）。

| keyframe | 定义（直译） | 用在 |
|---|---|---|
| `pie-breathe` | 0/100% scale(1)；50% scale(1.035)；3.4s EE infinite | idle 身体 |
| `pie-blink` | 0/91/100% scaleY(1)；95.5% scaleY(.1)；4.6s EE infinite | idle/listening 眼睛容器 |
| `pie-tilt` | 0/100% rotate(-5deg)；50% rotate(5deg)；2.8s ease-in-out infinite | thinking 身体 |
| `pie-dotjump` | 0/55/100% translateY(0)；27% translateY(-42%)；1.05s ease-in-out infinite，三点依次延迟 0.15s | thinking 三点 |
| `pie-thirdin` | from opacity 0 / translateX(-95%) scale(.35) → to 正常；0.5s EE both | thinking 第三点入场 |
| `pie-vibrate` | 0/100% translateX(0)；25% -1.6%；75% 1.6%；0.85s ease-in-out infinite | working 身体 |
| `pie-spin` | to rotate(360deg)；1.1s linear infinite | working 扫描环 |
| `pie-listen` | 0/100% scale(1)；50% scale(1.025)；2.0s ease-in-out infinite | listening 身体 |
| `pie-pulse` | from scale(.55) opacity .5 → to scale(2) opacity 0；1.9s ease-out infinite，第二环 delay 0.95s | listening 声波 |
| `pie-hop` | 0/100% translateY(0) scale(1,1)；14% scale(1.09,.9)；44% translateY(-17%) scale(.95,1.07)；72% scale(1.05,.95)；1.15s EE infinite | success 身体 |
| `pie-pop` | from scale(.4) opacity .55 → 78%/100% scale(1.7) opacity 0；1.15s EE infinite | success 光环 |
| `pie-wake-in` | 双眼从图标缺口位滑入（见下）；播**一次**，`both` fill | wake 眼睛 |

### wake（图标 → IP morph，改为播一次）

设计稿的 wake 是 4.8s 无限往返（图标↔脸）；植入版改为**单次** icon→face（时长 1.2s，EE 缓动，`animation-fill-mode: both`），播完由父层切到 `idle`（监听 `onAnimationEnd`）。

眼睛终点（直译设计稿 wake 帧）：左右眼圆心 `size/2 ∓ 0.16d`，`cy = dOff + 0.48d`（注：设计稿 wake 眼位 48%、idle 眼位 45%，切换时 3% 的落差肉眼不可辨，实现时可统一取 45% 消除跳变）。起始位（图标缺口，两眼同源分裂）：

- 右眼起点偏移：`translate(0.226d, -0.366d) scale(3.33)`
- 左眼起点偏移：`translate(0.546d, -0.366d) scale(3.33)`
- 即两眼都从右上缺口的大黑点出发，缩小滑入眼位。眼睛层需包在 `overflow: hidden` 的圆形 clip 内（滑入过程不出框）。
- wake 期间身体同时跑 `pie-breathe`。

## 状态接线（全部在 Chat.tsx 内 derive，无新全局状态、不持久化）

活跃动画**同屏永远只有一个**。

### 1. 空态（EmptyState，`Chat.tsx`）

- 现有随机问候语上方放大 IP，`size ≈ 140`。
- EmptyState 新增 prop：`listening: boolean`（= `input.length > 0`，Chat 已持有 composer 输入值）。
- 内部一个 `awake` flag：挂载 `state="wake"` → `onAnimationEnd` 置 awake → `idle`；`listening` 为 true 时无条件覆盖为 `listening`。

### 2. streaming 中（底部指示行，升级现 `WorkingIndicator`）

- mini `PieFace`（`size ≈ 22`）+ 现有 caps 状态文字改为动态：
  - `thinking`：`streamingThinking` 非空且 `streamingText` 为空 → 文字 `THINKING`（新 i18n key `chat.thinking`，**所有语言字典**同步补齐——parity 强制）。
  - `working`：其余 streaming 情形（有正文流出 / 工具步 pending）→ 沿用 `chat.working`。
- 保留现有 `role="status"` / `aria-live` / `panelRequest?.kind !== "schedule-model"` guard。
- streaming 期间，上方流式 assistant 气泡头显示**静止脸**（不动画）。

### 3. 完成（celebrate，瞬态）

- Chat 内跟踪 streaming 前值；`true → false` 且**成功收尾**（agent 任务：末尾 `agent-summary.success === true`；纯 chat 回复：正常 chat-done，非 abort）时置 `celebrate = true`，2.5s 后清除（约 2 个 success 循环）。
- celebrate 期间，**最后一条 agent 行**（assistant 气泡或 AgentSummary）头部的脸播 `success`；结束淡回 `static`。
- abort / 失败（`success === false`）：不播，直接 `static`；AgentSummary 的 warning 语义由现有文字颜色继续承载（设计稿无出错表情，不自创）。
- celebrate 不持久化：切会话、重开 panel、恢复历史都不重播。sessionId 变更时重置。

### 4. 历史消息头（静止脸）

- assistant 气泡头（`Chat.tsx` MessageBubble assistant 分支）：`h-1 w-1` accent 圆点 → `PieFace state="static" size={16}`，`AGENT` caps 文字保留。
- `AgentSummary.tsx` 头部：同样替换圆点为 16px 静止脸，`N STEPS DONE` / failure 文字与颜色逻辑不变。

## 测试（vitest + happy-dom）

- `PieFace.test.tsx`：每个 state 渲染出对应 `pie-*` animation 名；`static` 无 animation；working 有扫描环 / listening 有双声波 / success 有光环 / thinking 三点；`wake` 的 `onAnimationEnd` 回调触发。
- Chat 层：thinking vs working derive；celebrate 置位与 2.5s 清除（fake timers）；abort/失败不 celebrate；历史 assistant 头渲染静止脸。
- happy-dom 不真跑 CSS 动画，断言 style/animation 属性即可（仓库已有先例）。

## 改动面

| 文件 | 改动 |
|---|---|
| `src/sidepanel/components/PieFace.tsx` | 新增（+ `PieFace.test.tsx`） |
| `src/sidepanel/index.css` | Motion 区块加 `pie-*` keyframes |
| `src/sidepanel/components/Chat.tsx` | EmptyState 大 IP + listening prop；WorkingIndicator 升级；MessageBubble assistant 头静止脸；celebrate derive |
| `src/sidepanel/components/AgentSummary.tsx` | 头部圆点 → 静止脸（success 时可承载 celebrate） |
| i18n 字典（全部语言） | 新增 `chat.thinking` |

不动 SW / 消息协议 / 存储层。
