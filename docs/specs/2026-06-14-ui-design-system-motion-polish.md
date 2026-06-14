# UI 设计系统规整化 + 动画完善 — Design Spec

- 日期：2026-06-14
- 状态：Draft（待用户审阅 → 转 writing-plans）
- 范围：`pie-ai-agent` sidepanel UI
- 可视化依据：Paper「Pie Frontend」文件 · artboard「✦ Token Scales · 档位对比」（圆角/图标/字号三组档位）；既有「00 — Foundations · Dark」为权威设计系统源

---

## 1. 背景与现状

sidepanel UI 的视觉地基本身是好的，但**散落严重、缺乏 token 化与统一组件**，动画**不对称、不连贯、无集中约定**。本 spec 的目标是在不大改观感的前提下，把散落收敛成统一档位与组件，并系统性补齐动画。

### 1.1 设计系统现状（关键事实）

- **颜色** ✅ 已 token 化：`src/sidepanel/index.css` 的 `@theme` 定义完整语义色阶（slate accent `--c-accent #4A5C6E` / 黄铜 `--c-pending`：light `#8A6D2E` · dark `#B89968` / warning / success），并支持 light/dark + `data-theme` 覆盖。
- **字号** ✅ 已在设计系统定义（Foundations 板）：DISPLAY 22/700 · H2 18/600 · H3 16/500 · BODY+ 14/400 · BODY 13/400 · CAPTION 12/400 · CAPS 11/500/0.16em · MONO 12/400。**但代码里仍是 inline**：`text-[11px]`~`text-[17px]` 散落，未映射到这套档位。
- **圆角** ❌ 未量化：代码出现 **12 种**写法（`rounded` 默认 / `[2px]` / `[6px]` / `[7px]` / `[8px]` / `[9px]` / `[10px]` / `[14px]` / `md` / `lg` / `xl` / `full` / 一处不对称 `[10px_10px_2px_10px]`）。`rounded-[10px]` 是事实标准（~75 处）。
- **图标尺寸** ❌ 无语义档位：10/11/12/13/14/15/16/18/20px 混用、硬编码；实心(fill)/描边(stroke)混用无规律。图标为**自绘 SVG**（`src/sidepanel/components/icons.tsx` + 各组件内联），无外部图标库。
- **按钮** ❌ 无统一组件：**121 个手写 `<button>`**，6+ 种 variant（primary 实心 `bg-fg-1` / secondary 描边 / ghost / danger / icon-only / link-like）各写各的 className，padding / 字号 / 圆角全凭手感。
- 间距 / 阴影同样未 token 化（`shadow-[0_8px_24px_...]` 硬编码）。

### 1.2 动画现状（关键事实）

- **零动画库**，纯 CSS。`src/sidepanel/index.css:204-246` 集中定义 5 个语义 keyframes（`view-enter` / `bubble-in` / `scale-in` / `scale-out` / `drawer-down`），统一缓动 `cubic-bezier(0.32,0.72,0,1)`（Raycast 风格），并已支持 `@media (prefers-reduced-motion)` ✅。
- **散落**：duration/easing 分散在 CSS class、inline style、Tailwind utility 5+ 处（140/150/180/200/220/240/300ms 硬编码），无 `@theme` token。
- **不对称**：展开有动画、收起常常没有 —— `InstancesList.tsx:68`（drawer-down 仅进入）、`CollapsibleText.tsx`（maxHeight 无过渡）、`AgentStepGroup.tsx`（仅 chevron 旋转、内容无动画）。`PinnedTabDropdown.tsx` 需手动 `onAnimationEnd` 才能在关闭时播放退出动画。
- **缺场景**：无 Modal / Toast / 列表项增删动画。用户明确要的"展开时把同级元素推走"目前只有 `ModelPicker.tsx` 用 `grid-template-rows` 实现了一处。

---

## 2. 目标与非目标

### 目标
1. 把"颜色/字号已 token 化"扩展到 **圆角 / 字号(落地) / 图标尺寸 / 动画时长 / 缓动 / 阴影**，集中进 `@theme` + CSS 变量。
2. 抽出 **`Button` / `IconButton`** 两个承载组件，吃 token，逐步取代手写按钮。
3. 定下 **图标实心 vs 描边规范**。
4. 引入轻量动画库，封装 **动画原语**，补齐双向 / 对称 / 推挤动画，统一吃时长 token。

### 非目标（YAGNI）
- **不重定义视觉方向**：性质是"收拢统一 + 明显粗糙处克制精修"，观感基本不变。
- **不重做字号档位**：沿用 Foundations 既有 7 档，只做代码对齐。
- **不在本期一次性迁完全部 121 个按钮 / 所有组件**：地基优先 + 高频先迁，其余增量。
- **不与 v0.20 侧栏重做合并**：本期只打"系统化"地基、不改视觉方向；v0.20 落地时复用本期 token / 组件。

---

## 3. 关键决策（已与用户确认）

| 决策点 | 选定 |
|---|---|
| 规整性质 | **收拢统一 + 适度精修**（观感基本不变） |
| 推进范围 | **地基优先 + 高频先迁**，其余增量 |
| 动画实现 | **引入 `motion`（原 framer-motion）**，`auto-animate` 兜底 |
| 圆角档位 | **sm 6 / md 10 / lg 14 / full**（md=10 延续代码事实标准，观感零变化） |
| 图标档位 | **sm 14 / md 16 / lg 20** + 实心/描边规范 |
| 字号 | **沿用 Foundations 7 档**，代码 inline 值映射过去 |

---

## 4. 线 A — 设计系统地基

### 4.1 Token 扩展（`src/sidepanel/index.css` 的 `@theme` + CSS 变量）

> 注：TailwindCSS v4 是 CSS-first。`@theme` 内的 `--radius-* / --text-* / --shadow-*` 会生成对应 utility，需确认覆盖语义不与 Tailwind 默认 keyword（如 `rounded-lg`）冲突 —— 实现细节留 plan，本 spec 锁定**档位值与语义名**。

**圆角**（语义命名，**新增不覆盖** Tailwind 默认 `rounded-sm/md/lg`，避免现有 `rounded-md/lg` 用法静默漂移 —— 见 §8）
```
--radius-chip:    6px     /* icon button · chip · 小指示  → rounded-chip */
--radius-control: 10px    /* 按钮 · 输入框 · 小卡（事实标准） → rounded-control */
--radius-card:    14px    /* 大卡片 · section 面板 → rounded-card */
/* full 沿用 Tailwind 默认 rounded-full（9999px）：药丸 · 开关 · 圆点 */
```
代码迁移：`[2px]/[7px]/[8px]/[9px]` → 就近收敛到 `chip/control`；`[10px]` → `control`；`[14px]` → `card`；`full` 不变；不对称 `[10px_10px_2px_10px]` → `control`；现有默认 keyword `rounded-md/lg/xl` 随各 Batch 显式换成 `control/card`（值不变前不动）。

**字号**（沿用 Foundations，落地为语义 token，配 line-height）
```
display 22/700 · h2 18/600 · h3 16/500 · body-lg 14/400 · body 13/400 · caption 12/400 · caps 11/500(0.16em)
```
代码映射：`text-[11]`→caps/小字 · `[12]`→caption · `[13]`→body(默认) · `[14]`→body-lg · `[15]`→就近 14 或 16 · `[16]`→h3 · `[17]`→就近 16 或 18 · `[18]`→h2 · `[22]`→display。越界值（15/17）收敛到最近档。

**图标尺寸**（落地为常量/size token，给 SVG 组件 `size` prop 用）
```
icon-sm 14 · icon-md 16 · icon-lg 20
```
代码迁移：10–13 → `sm`；14–16 → `sm/md`（按角色，见 4.3）；18–20 → `lg`。

**动画时长 / 缓动**（给 motion transition 与残留 CSS 共用）
```
--ease-standard: cubic-bezier(0.32,0.72,0,1)   /* 提取现有缓动为 token */
--dur-fast: 140ms    /* 退出 · 微交互 */
--dur-base: 200ms    /* 标准进出场 */
--dur-slow: 260ms    /* 抽屉 · 大面板 */
```

**阴影**（两档语义；具体值由现有 `shadow-[0_8px_24px_rgba(...)]` 提炼、plan 定稿）
```
--shadow-pop:     popover · dropdown 浮起
--shadow-overlay: drawer · modal backdrop 浮层（更重）
```
取代散落的 `shadow-[0_8px_24px_...]` 硬编码。

### 4.2 承载组件：`Button` / `IconButton`

新增 `src/sidepanel/components/ui/Button.tsx`、`IconButton.tsx`（目录 `ui/` 收纳设计系统原语）。

**`<Button>`**
- `variant`: `primary`（实心 `bg-fg-1 text-canvas`）/ `secondary`（描边 `border-line`）/ `ghost`（透明·hover 底 `bg-field`）/ `danger`（warning 调）
- `size`: `sm`(h-8) / `md`(h-9)
- 统一：`radius-md`、字号 `body`、`gap-1.5`、`iconLeft`/`iconRight` 槽、`loading`（内置 spinner）、`disabled`（`opacity-30`）、`fullWidth`
- 目标：逐步吃掉 121 个手写 `<button>`

**`<IconButton>`**
- `size`: `sm`(28×28) / `md`(32×32)，正方形
- `variant`: `default` / `ghost`（hover `bg-field`）
- 统一：`radius-sm`、图标居中、`icon-sm/md`、必填 `aria-label`

### 4.3 图标实心 / 描边规范

- **描边 (outline · stroke 1.5)** = 操作 / 导航 / 可点击功能图标：caret · edit · close · search · back · theme 等。统一 `stroke-width 1.5`。
- **实心 (filled · fill)** = 标识 / 语义状态 / 不可点装饰：品牌 logo · 文件类型 · 状态点 · 进度环 · 圆点。
- 现有自绘 SVG 收进 `icons.tsx` 统一管理，加 `size` prop 吃 icon token。

---

## 5. 线 B — 动画系统

### 5.1 库选型 + 前置 spike

**选 `motion`**（`motion/react`，原 framer-motion 演进版），用 `LazyMotion + domAnimation + m.*` 按需引入控包体。

理由：
1. `AnimatePresence` 是"打开和关闭都有动画"（退出时延迟卸载）的权威解 —— 直接补当前最缺的"关闭无动画"。
2. `layout` prop 自动 FLIP —— 实现"展开把同级元素推走"。
3. transition 可吃 `--dur-* / --ease-standard`，与残留 CSS 视觉一致。

**CSP 已核对**：`manifest.json:30` = `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`（无 `'unsafe-eval'`）。motion 走 WAAPI + rAF + transform，不用 `eval`/`new Function`，静态判断 CSP 安全。

**Task 0 spike（前置硬门槛）**：实际 `pnpm add motion` → `pnpm build` 通过 → 在真实扩展页（side panel）运行一个 `AnimatePresence` demo → 量包体增量。
- 通过 → 按本 spec 继续。
- 不通过（CSP 拦截 / 包体不可接受）→ **兜底降级 `@formkit/auto-animate`**（~3KB，零配置 `useAutoAnimate` 做推挤/增删）+ 保留纯 CSS keyframes 做进出场。

### 5.2 动画原语（封装在 `ui/`，业务组件不直接碰 motion API）

| 原语 | 作用 | 取代现状 |
|---|---|---|
| `<Collapse open>` | 双向展开/收起 + 推挤（height auto / grid-rows） | `InstancesList` / `AgentStepGroup` / `ThinkingSection` / `CollapsibleText` 的单向或无动画 |
| `<Popover>` / `<Dropdown>` 包装 | AnimatePresence origin-aware scale+fade 进出场 | 散落的 `scale-in/scale-out` + 手动 `onAnimationEnd` |
| `<Drawer>` / `<Modal>` 包装 | AnimatePresence + backdrop fade | `SessionDrawer` 现有 transform 收编，并为未来 Modal/Toast 留标准 |
| `<AnimatedList>` | `layout` + AnimatePresence 列表项增删位移 | `SessionRow` / 配置列表 / `FileChip` 新增/删除无动画 |

**保留**：高频纯入场（消息气泡 `bubble-in`）继续用 CSS keyframes，不全上 motion，避免过度包装。

### 5.3 时长 / 对称约定

- 进 = `dur-base`、出 = `dur-fast`（出场更快，延续现有 `scale-out 140` 手感）。
- motion 与残留 CSS 都吃同一组 `--dur-* / --ease-standard`。
- `useReducedMotion`（motion）+ 现有 `@media (prefers-reduced-motion)` 双保险。

---

## 6. 推进顺序（地基优先 + 高频先迁）

- **Batch 0 — 地基**：Task 0 motion spike · `@theme` token 扩展 · `Button`/`IconButton` · 动画原语（Collapse/Popover/Drawer/AnimatedList）。
- **Batch 1 — 高频迁移**：`TopBar*Button`（5 个）→ `ModelPicker` → Composer（Chat 输入区）→ Chat 消息气泡 → `SessionDrawer` → `Settings` 各 tab。
- **Batch 2 — 增量**：`InstancesList`/`InstanceForm`/`NewConfigWizard` · `SearchProviderSection` · `Managed*` · `ProviderDropdown`/`ProviderModelList` · 各 Card · `SkillsList` · `Schedules/*`。
- **Batch 3 — 固化**：写「设计系统 + 动画」规范文档（落 `docs/solutions/`）；评估防回潮守则（可选 build-time/lint 检查，参考 `tool-names.ts` invariant 思路，但需克制避免误伤）。

每个 Batch 可独立合并、独立验证。

---

## 7. 验证策略

- **vitest**：`Button`/`IconButton` 的 variant + size + a11y（aria-label/disabled）；`Collapse`/`Popover` 的 open/close 渲染与卸载时机。
- **`pnpm build`**：包体增量对比（基线 vs 引入 motion 后）；CSP 不破（扩展页正常加载、SW 注册成功）。
- **`pnpm typecheck`**：repo-wide 保持 0 错。
- **prefers-reduced-motion**：开启后动画塌缩为最终态、无位移。
- **真机回归**：高频路径（TopBar 按钮 / ModelPicker 展开 / Composer / 消息进入 / SessionDrawer 开关 / Settings tab 切换 / 各 dropdown 开关）。

---

## 8. 风险与兜底

| 风险 | 缓解 |
|---|---|
| motion CSP/包体不可接受 | Task 0 前置 spike 把关；兜底 `auto-animate` + CSS keyframes |
| 全量触面大、回归风险 | 分 Batch，每批可独立合并验证；高频先迁早暴露问题 |
| `@theme` token 覆盖 Tailwind 默认 keyword 语义漂移（如 `rounded-lg`） | plan 阶段确认覆盖语义；优先用语义命名（如 `text-body`）避免与默认数值档冲突 |
| 与 v0.20 侧栏重做并行冲突 | 本期只打地基不改视觉方向，v0.20 复用本期 token/组件 |
| 字号越界值（15/17px）收敛引起细微变化 | 就近归档，真机回归核对受影响处 |

---

## 9. 参考

- 现状地图：本 spec §1（由两轮代码探索得出，引用具体文件:行号）
- 设计系统权威源：Paper「Pie Frontend」·「00 — Foundations · Dark」
- 档位可视化：Paper「✦ Token Scales · 档位对比」（圆角/图标/字号）
- 动画现状集中地：`src/sidepanel/index.css:204-246`
- 颜色/字号 token：`src/sidepanel/index.css`（`@layer base` + `@theme`）
- CSP：`manifest.json:30`
- 相关记忆：「侧栏重做 v0.20」（v0.20 重做并行、复用本期地基）
