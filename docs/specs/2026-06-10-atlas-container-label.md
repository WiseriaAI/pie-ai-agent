# Atlas 容器型 target 取名修复（table/collection label）

- 日期：2026-06-10
- 状态：设计已确认（方案 A）
- 触发：WebArena eval task 127 可复现回归（deepseek-v4-pro 两次独立运行同错）

## 问题

`read_page({mode:"atlas"})` 产出的 table/collection target 的 `label` 经常是**整个容器的文本内容拼接**（content digest），而不是表格的语义标题。多表页面（仪表盘、报表页）上模型无法区分表格身份，只能自行猜测题意。

实证（eval task 127，Magento admin dashboard）：

- 页面有两张搜索词表：**Top Search Terms**（按 Uses 降序，正确答案来源）与 **Last Search Terms**（按时间序）。
- atlas 给两张表的 label 都是 `"Search Term Results Uses tanks 23 1 nike 0 3 …"` 式内容摘要，页签语义丢失。
- 模型把 "top 3 search terms that match available products" 解释为按 Results 列排序 → 答 `["tanks", …]`，期望 `Hollister; Joust Bag; Antonia Racer Tank`。两次运行错得一字不差（输入呈现的确定性误导）。
- 旧 `read_page` 全文路径保留原始 HTML 上下文（标题 div 紧邻表格），基线时期此任务通过。

## 根因

`src/lib/dom-actions/probe-core.ts`：

1. `targetLabel(el, fallback)`（:754）= `accessibleName(el) || nearestSection(el) || fallback`。
2. `accessibleName`（:365-380）查 aria-label → aria-labelledby → title → name 全空后，**兜底返回 `descendantText(el)`**（:379，即 `el.textContent` 全文）。
3. 容器型元素（table/列表容器）几乎从不带 aria 属性 → label 被内容摘要污染，且非空返回**遮蔽了 `nearestSection`**。
4. 即便修掉 2/3，`nearestSection`（:326）只认 `h1,h2,h3,[role='heading']`——Magento 仪表盘的表格标题是**普通 `<div>Top Search Terms</div>` 前置兄弟节点**，不是 heading，仍然找不到。

```html
<!-- 真实 DOM（取自旧基线 trace） -->
<div>
  <div>Top Search Terms</div>
  <div><table id="topSearchGrid_table">…</table></div>
</div>
```

附带问题：descendantText 兜底会把整表文本塞进 label 属性（token 膨胀），`find_in_atlas` 的 label 匹配（target-tools.ts:118）也会被内容词污染（搜任意单元格词会误中 label）。

## 设计（方案 A）

只改 `targetLabel`——它的全部调用方（table :865、collection :967）都是容器型 target，无其他消费方。控件取名的 `accessibleName` **保持不动**（按钮/链接用 descendantText 是正确行为）。

新取名链（命中即停，全程不用 descendantText）：

1. **显式 ARIA/title**：`aria-label` → `aria-labelledby`（textById 解析）→ `title` 属性。
2. **`<caption>`**：table 专属，取 caption 可见文本。
3. **祖先 tabpanel**：向上找最近的 `[role="tabpanel"]` 祖先，解析其 `aria-labelledby` / `aria-label`（真 tab 页面的标准关联）。
4. **前置兄弟标题启发式**（新增，本案例的关键）：从 `el` 起向上走 ≤3 层祖先；每层沿 `previousElementSibling` 链找第一个**短文本元素**——可见、文本 ≤60 字符且非空、自身不含 table/list 等容器。命中取其文本。层内就近优先，层间由内向外。
5. **`nearestSection`**：保留现有逻辑（祖先内 heading）。
6. **fallback**：调用方传入的 `Table N` / collection fallback。

各级结果统一过 `safeText`（escape + 截断，与现状一致）。

### 边界与取舍

- 启发式第 4 级的误判风险（拿到无关短文本）有界：仅短文本、就近优先、且任何结果都严格优于现状（内容摘要或空泛 "Table N"）。
- 不缓存、不改 atlas 数据结构、不动 render/types/state——label 是采集期一次性计算，纯函数替换。
- collection 调用方（:967）现有第二参 `nearestSection(group[0]) || fallbackLabel` 维持不变，新链对其同样生效。

## 非目标

- 方案 B（render 层 tab 控件 ↔ target 关联、`tab_label` 属性）：本案例非 tab 结构，YAGNI。
- 改 `accessibleName` 本身：控件路径行为正确，动它影响面大。
- 语义化 id 兜底（如 `topSearchGrid_table` → "topSearchGrid table"）：启发式 4 已覆盖实际场景，id 人化转换噪声大，暂不做。

## 测试计划（TDD，happy-dom，probe-core.test.ts）

取名链每级一个用例 + 优先级覆盖：

1. table 带 `aria-label` → 用之（不被 caption 覆盖）。
2. table 带 `<caption>` → 用之。
3. table 在 `[role=tabpanel] aria-labelledby` 祖先内 → 解析页签标题。
4. **Magento 形状**：`<div><div>标题</div><div><table/></div></div>` → 取前置兄弟 div 文本（核心回归用例，含双表场景断言两表 label 互异）。
5. 无任何线索 → `Table N` 兜底，且 label **不含**单元格内容（防 descendantText 回归）。
6. collection 容器同链路径覆盖（一个代表性用例）。
7. 短文本判定边界：>60 字符的前置 div 不当标题。

## 验证

- `pnpm test`、`pnpm typecheck`、`pnpm build` 全绿。
- `pnpm build:eval` 重建 dist-eval，重置 shopping_admin 容器后复跑 eval task 127：断言 atlas 观察中两表 label 分别含 "Top Search Terms" / "Last Search Terms"，任务得分 1.0。

## 不变量确认

- 不触碰 PR #152 interactive parity 常量（`interactive-parity.test.ts` 不涉 targetLabel，已确认）。
- `<untrusted_*>` wrapper 体系不变（label 仍走既有 escape 路径）。
- tool-names.ts read/write 分类不变（无新 tool）。
