# 交互快照：隐藏表单控件的 Label 救援

设计文档 · 2026-06-06 · 关联 issue [#141](https://github.com/WiseriaAI/pie-ai-agent/issues/141)

## 1. 背景与问题

WebArena mutate 评测里,一类任务稳定失败:agent 进对了页面、也想操作,却报告"控件没有 `pie_idx`,无法点击"。代表任务:

- **454 / 453** — 禁用产品(Magento 产品编辑页的 "Enable Product" 开关)
- **423 / 501** — grid 批量改属性(Actions 下拉菜单项)

早期失败归因把这些误标成"模型把值填错了"。逐任务读 trace + 解码 HAR 后证实:**agent 从未提交过任何值——它连控件的句柄都拿不到。** 这是 Pie 交互层的覆盖缺口,不是模型推理问题。

## 2. 根因(已用活页面探针证实)

在真实 Magento(`localhost:7780`,admin 登录)上对任务 454 的产品编辑页做了非破坏性探测,结论如下:

1. "Enable Product" 开关的真实控件是 `<input type="checkbox" name="product[status]">`,但它被渲染成 **1×1 像素**(视觉隐藏,另由一个 styled `<label>` 充当可见开关)。
2. 快照的 `isVisible`(`page-snapshot.ts:117-128`)把它滤掉——命中 L124-126 的「`<8×8px` 的 input」规则。
3. 真正可见、可点的是它的关联 `<label class="admin__actions-switch-label" for="...">`(69×22px),但 **`<label>` 不在 `INTERACTIVE_SELECTOR` 里**,且它没有 `onclick`/`role`/`tabindex` → 也不会被盖戳。
4. 结果:隐藏 input 和可见 label **都没有 `pie_idx`** → agent 无任何可操作句柄 → 锁死。

**关键正向证据(决定方案):**

- 对那个可见 label 做一次**真实坐标点击**(等价于 Pie 的 CDP `Input.dispatchMouseEvent`),KnockoutJS 的 `simpleChecked` 绑定接住原生 label→input 联动,组件值从 `'1'`(Enabled)翻到 `'2'`(Disabled),DOM 复选框同步 unchecked。
- 即:**只要让那个可见 label 进快照、拿到 `pie_idx`,现有的 CDP `click` 就能驱动整条框架链。** 不需要 main world,不需要框架知识,不需要新工具。

(同一轮探针还证实:Magento_Ui / KO / prototype.js 这些框架都响应 isolated world 的合成 DOM 事件、不查 `isTrusted`;订单地址页的 region 同步用现有 `select`+`change` 即可。故 main world 在已知失败里**无一例需要**,留作未来扩展。详见 §8。)

## 3. 目标与范围

### 目标
让"本体不可见、但有可见关联 label"的表单控件,通过 label 获得 `pie_idx`,使 agent 能用现有 `click` 操作它;条目要让 agent 看懂这是个什么控件、当前什么状态。

### 范围内
- `page-snapshot.ts` 盖戳逻辑:对隐藏表单控件做 label 救援。
- `interactiveSummary`:对救援出的 label 条目,经其关联控件富化(role / checked / type / name)。
- `search-page.ts`:同步同一套救援逻辑(verbatim 副本不变量)。

### 范围外(本版不做,见 §8 延期项)
- **Gap 2**:可见但靠框架点击绑定(如 `<span data-bind="click:...">`)的菜单项(423/501 的高效批量路径)——另一类机制,框架专有、噪声更大。
- **main world 注入通路**:留接口,不实现。
- **#142**(select 事件同步 / region):另一处独立小修,与快照可达性无关。

## 4. 设计

### 4.1 盖戳阶段（page-snapshot.ts，Step C）

现状(`page-snapshot.ts:351-358`):

```js
let stampIdx = 0;
for (const el of liveBodyElements) {
  if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
    stamp(el);  // setAttribute data-pie-idx on el + its clone
  }
}
```

新增「救援」分支:

```js
for (const el of liveBodyElements) {
  if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
    stamp(el);
  } else if (isRescuableControl(el) && !isVisible(el)) {
    const label = visibleLabelFor(el);
    if (label && !label.hasAttribute("data-pie-idx")) {
      stamp(label);   // 盖在 label 上（label 有真几何，CDP 可点）
    }
  }
}
```

辅助函数(内联进注入函数,自包含):

- `isRescuableControl(el)`：仅 `input[type=checkbox]` / `input[type=radio]`。**收紧理由(实现期 review 定稿)**:救援把 `pie_idx` 盖在 `<label>` 上,而 checkbox/radio 的"单击 label = 原生 toggle/select = 完整交互";`select`/`textarea`/text input 即便救援,`select_option`/`type` 也会拒绝 `<label>` 目标 → 变成"可发现但不可操作"的误导条目,故排除。
- `visibleLabelFor(el)`：`Array.from(el.labels ?? []).find(isVisible)`。`HTMLInputElement/Select/TextArea.labels` 原生覆盖 `for=` 关联与 `<label>` 包裹两种形式。

**为什么盖在 label 而非 input:** `click` 是 CDP 按坐标点击(`mouse.ts` → `elementToPagePoint` 取 `getBoundingClientRect` 中心),对 1×1 的 input 会因零尺寸报 `element-not-visible`。label 有真实几何,坐标点击命中 → 原生 label→input 联动 → 框架驱动。

### 4.2 条目富化（interactiveSummary）

救援出的索引元素是 `<label>`,但 agent 需要看懂它语义上是个 checkbox/switch 及其当前勾选态。利用 `HTMLLabelElement.control` 直接拿关联控件富化:

```js
function interactiveSummary(el) {
  const isRescuedLabel = el.tagName.toLowerCase() === "label" && el.control;
  const ctl = isRescuedLabel ? el.control : el;     // 富化取自关联控件
  const input = ctl instanceof HTMLInputElement ? ctl : null;
  return {
    pieIdx,
    tag: el.tagName.toLowerCase(),                   // 仍是 "label"（如实）
    role: inferredRole(ctl),                          // → checkbox / switch
    name: rescuedName(el, ctl),                       // 见下
    type: input ? input.type.toLowerCase() : ...,     // → "checkbox"
    checked: input ? input.checked : ...,             // → 当前 Enabled/Disabled
    disabled: ctl.hasAttribute("disabled"),
    ...
  };
}
```

> **名称来源要点(实现时用 TDD 钉死):** Magento 的可见 switch-label 自身文本只是 "Yes/No",字段名 "Enable Product" 在外层 `.admin__field-label`。救援条目的 `name` 必须呈现人类可读的字段名,取值优先级:`accessibleName(ctl)` → 最近字段 label(`nearestSection`/邻近 `.field-label`)→ label 文本。务必让 agent 看到 "Enable Product" 而非 "Yes/No"。

`tag` 仍如实报 `label`,只是 role/type/checked 反映被控件——这样 agent 既知道是开关、又能读到当前态来决定是否点击。

### 4.3 search-page.ts 同步

`search-page.ts` 持有一份 verbatim 的 walk/isVisible/盖戳逻辑(见文件头注释 + `interactive-parity.test.ts`)。同一套救援分支与富化必须复制过去,否则 `search_page` 找不到救援控件、与 `read_page` 口径漂移。

## 5. 数据流（agent 视角）

1. `read_page` → 隐藏开关现在以 label 为载体出现在 `<interactive_index>`,呈现为 `checkbox "Enable Product" [checked]`(带 frameId + pieIdx)。
2. agent 读到 `checked=true` → 知道产品当前 Enabled → 决定点击以禁用。
3. `click(frameId, pieIdx)` → CDP 坐标点击 label 中心 → 原生联动 + KO 驱动 → 组件值翻转。
4. agent 复读 `read_page` → 条目变 `[unchecked]` → 确认生效 → 保存。

## 6. 边界与不变量

- **不重复盖戳**:正常可见复选框,input 自身被盖,`else if` 不触发,label 不在选择器里→不会被索引,无双句柄。
- **label 也不可见**:`visibleLabelFor` 返回空 → 不索引(确属不可达,正确放弃,落入 Gap 2)。
- **无可见 label 的隐藏控件**(自定义 div 开关):救援找不到 label → 不索引 → Gap 2 territory,本版不管。
- **type=hidden**:排除(无 label、无交互语义)。
- 维持 `interactive-parity` 与 idx-parity 不变量:救援逻辑不改 `INTERACTIVE_SELECTOR` 字面量(它在 walk 逻辑里,不在选择器串里),但**两份注入副本必须一致**。

## 7. 测试（TDD）

红-绿-重构,新增测试覆盖:

1. **救援盖戳**:fixture = 1×1 隐藏 `<input type=checkbox id=x>` + 可见 `<label for=x>Enable</label>`;断言 label 拿到 `data-pie-idx`、input 没拿到。
2. **条目富化**:断言该条目 `type="checkbox"`、`role` 为 checkbox/switch、`checked` 反映 input 的真实勾选态、`name` 呈现字段名(非 "Yes/No")。
3. **不误伤正常控件**:可见 checkbox + 可见 label → input 被索引、label 不被索引(无重复)。
4. **不可达不索引**:input 隐藏且 label 也隐藏 → 都不索引。
5. **包裹式 label**:`<label>Enable<input type=checkbox></label>`(隐藏 input)→ 经 `el.labels` 救援成功。
6. **search-page 平价**:同一 fixture 下 `search_page` 能命中救援控件,口径与 `read_page` 一致。

## 8. 延期项（文档化，本版不做）

- **Gap 2 — 框架点击绑定的可见元素**:`<span/div data-bind="click:...">` 等无 form-control、无 role 的菜单项(grid 批量 Actions、Select All)。需要给选择器加针对性信号(如 `[data-bind*="click"]`,KO/Magento 专有)或更通用启发式;噪声与框架耦合更高,单独评估。
- **main world 注入接口**:已验证已知失败无一需要 main world(KO/Magento_Ui/prototype.js 都吃 isolated 合成事件)。但复杂页面(查 `isTrusted` 的控件、纯 JS-state 无 DOM 事件路径的控件)未来可能需要。**对冲做法**:将来新增 executeScript 类设值动作时,把注入 helper 做成 `world: "ISOLATED" | "MAIN"` 可参数化——加 main 是配置而非重构。本版无新注入动作,故此项仅为决策记录,不写代码。
- **#142 — select 事件同步**:539 的 region 在直测中用现有 `select`+`change` 即可同步,失败疑似时序/未回读;与本设计无关,单独处理。

## 9. 风险

- **名称呈现不准** → agent 看不懂控件:由 §4.2 的名称优先级 + TDD 用例 2 兜底。
- **救援噪声**:仅"隐藏 form-control + 可见 label"会被救,集合很窄(toggle/styled checkbox/radio),噪声低。
- **两份注入副本漂移**:由 `interactive-parity.test.ts` + 新增 search-page 平价用例守住。
