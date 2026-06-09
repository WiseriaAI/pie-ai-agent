# 设计：Page Atlas 渐进式页面读取与结构化抽取

- 日期：2026-06-09
- 状态：设计稿，待评审
- 关联背景：`read_page` 当前可返回整页 HTML / interactive index / frame map，但大页面和多轮读取会消耗大量 token；后续优先服务网页操作与结构化数据抽取。

## 1. 背景与问题

当前 `read_page` 的心智模型仍偏向「把页面内容读给 LLM」：

- 页面越复杂，返回内容越大，token 成本越不可控。
- 即使有 `mode` / `max_bytes`，LLM 拿到的仍是截断后的页面片段，不一定知道未读部分在哪里。
- 对网页操作来说，LLM 最需要的是可操作控件、表单、导航、状态，而不是全文。
- 对结构化抽取来说，LLM 最需要的是表格、列表、重复记录、字段形状，而不是整页 HTML。
- 若直接新增一个页面级 `extract_data` 工具，LLM 很容易跳过定位流程，一上来就尝试抽取，导致目标不明确、结果不稳定。

因此本设计把页面读取从「一次性 dump」改成「地图 + 目标 + 定向展开」：

```text
read_page(atlas)
  -> 发现页面的 action surfaces 与 data surfaces
  -> LLM 选择或查找 target
  -> read/extract target
```

## 2. 目标 / 非目标

**目标**

1. 将 `read_page` 第一版重构方向定义为 Page Atlas：默认返回页面地图，而不是大段全文。
2. 优先服务两个场景：
   - 网页操作：识别控件、表单、筛选器、分页器、导航、可交互区域。
   - 结构化抽取：识别 collections、records、tables、字段形状、可分页/可滚动范围。
3. 设计 target 级工具协议：抽取工具必须依赖 atlas 产生的 `target_id`，不能凭自然语言直接扫页面。
4. 设计工具披露与 fail-closed 规则，降低 LLM 误触发「一步到位抽取」的概率。
5. 明确 `search_page` 的定位：第一版不作为公开 LLM 工具；搜索先收敛为 atlas 内部能力和 target 定位能力，语义搜索成熟后再以 atlas 绑定形式披露。

**非目标**

- 第一版不追求完整网页问答/全文总结体验；问答可由后续 `read_section` / semantic search 补齐。
- 第一版不做全页向量索引；语义搜索作为 V2 能力。
- 第一版不要求所有页面都能完美分类；未知页面必须有 region 级兜底。
- 第一版不替代现有 click/type/select 等操作工具；Page Atlas 只提供更好的索引和目标定位。
- 第一版不把页面内容放入 system prompt；所有页面来源内容仍必须走 untrusted wrapper。

## 3. 核心心智模型

网页对 LLM 不应表现为「一段 HTML」，而应表现为一个可探索的信息空间：

```text
Page Atlas = 页面地图
Target = 可操作或可抽取的页面对象
Evidence = 按需展开的原始证据
Action = 对 target/control 执行操作
Extraction = 从 target 中抽取结构化记录
```

Page Atlas 第一版以两个 surface 为中心：

### 3.1 Action Surface

描述页面能做什么操作。

典型对象：

- form：搜索框、登录表单、创建表单、筛选表单。
- control group：筛选器、排序器、tab、菜单、工具栏。
- navigation：分页器、下一页按钮、面包屑、站内导航。
- editor/input surface：编辑器、文本输入区、上传区。

### 3.2 Data Surface

描述页面暴露了哪些可抽取数据。

典型对象：

- collection：搜索结果、商品列表、评论列表、邮件列表、issue 列表。
- record：collection 中的一条重复项。
- table：明确行列结构的数据。
- detail region：商品详情、用户资料、订单详情等非重复但字段密集区域。

## 4. Page Atlas 输出形态

`read_page({ mode: "atlas" })` 返回低 token 的页面地图。它应优先返回结构与索引，而不是完整正文。

示例形态：

```text
<page_atlas atlas_id="atlas_7f3" tab_id="123" url="https://example.com/search" title="Search">
  <page_class>search_results</page_class>

  <action_surfaces>
    <form id="form_f1" label="Search">
      <field control_id="ctrl_12" pie_idx="12" type="text" label="Keyword" value="" />
      <field control_id="ctrl_13" pie_idx="13" type="select" label="Region" />
      <submit control_id="ctrl_14" pie_idx="14" label="Search" />
    </form>

    <control_group id="controls_g1" label="Filters">
      <control control_id="ctrl_21" pie_idx="21" type="checkbox" label="Open now" />
      <control control_id="ctrl_22" pie_idx="22" type="select" label="Sort by" />
    </control_group>
  </action_surfaces>

  <data_surfaces>
    <collection id="collection_c1" label="Search results" visible_records="10" estimated_total="240">
      <field_guess name="title" confidence="high" />
      <field_guess name="link" confidence="high" />
      <field_guess name="rating" confidence="medium" />
      <field_guess name="location" confidence="medium" />
      <next_actions>
        read_collection(target_id="collection_c1", range="0..10")
        extract_records(target_id="collection_c1", schema={title:string, link:string, rating:string, location:string})
      </next_actions>
    </collection>

    <table id="table_t1" label="Orders" visible_rows="25" paginated="true">
      <columns>Order ID, Customer, Status, Amount, Date</columns>
      <next_actions>
        read_table(target_id="table_t1", range="0..25")
        extract_records(target_id="table_t1", schema={order_id:string, customer:string, status:string, amount:string, date:string})
      </next_actions>
    </table>
  </data_surfaces>

  <navigation_surfaces>
    <pagination id="nav_p1" current_page="1" next_control_id="ctrl_80" />
  </navigation_surfaces>
</page_atlas>
```

输出格式可以继续沿用现有 XML-like observation 风格，方便与 `untrusted_page_content`、`frame_map`、`interactive_index` 保持一致。

## 5. 抽象对象

第一版只定义少量稳定抽象，避免过度语义化。

| 抽象 | 用途 | 识别信号 |
|---|---|---|
| `control` | 单个可操作控件 | button/input/select/link/role/aria/label |
| `form` | 一组字段和提交动作 | form 标签、相邻 input、submit button、label |
| `control_group` | 筛选器、排序器、tab、工具栏 | role/group、fieldset、相邻 controls、视觉/DOM 聚类 |
| `collection` | 重复记录列表 | 重复 DOM shape、相邻卡片、列表容器、搜索结果结构 |
| `record` | collection 中单条记录 | collection 子项 |
| `table` | 行列结构 | table 标签、grid role、重复 row/column pattern |
| `detail_region` | 字段密集但非重复区域 | dl、label/value pairs、profile/detail cards |
| `region` | 兜底页面区域 | landmark、heading section、DOM block |

## 6. 工具协议

### 6.1 发现工具

```text
read_page(tabId, mode="atlas")
```

职责：

- 生成 `atlas_id`。
- 返回 action surfaces、data surfaces、navigation surfaces。
- 返回 `control_id -> pie_idx/frame_id` 映射。
- 返回每个 target 的 `next_actions`。
- 不默认返回整页正文。

`read_page(mode="interactive")` 可继续保留，作为操作前刷新 interactive index 的模式。

### 6.2 定位工具

```text
find_target(atlas_id, query, kind?)
```

职责：

- 只在已有 atlas 的 targets 中搜索。
- 返回候选 `target_id`、类型、label、reason、confidence。
- 不扫全页全文，不返回大量页面内容。

示例：

```json
{
  "query": "product prices",
  "kind": "data"
}
```

返回：

```json
{
  "candidates": [
    {
      "target_id": "collection_c1",
      "type": "collection",
      "reason": "Repeated product-like cards with price-like text",
      "confidence": "high"
    }
  ]
}
```

### 6.3 读取工具

```text
read_collection(atlas_id, target_id, range?, fields?)
read_table(atlas_id, target_id, range?, columns?)
read_target(atlas_id, target_id, mode="summary|text|html", max_bytes?)
read_more(atlas_id, cursor, max_bytes?)
```

职责：

- 只读取明确 target。
- 对长列表/虚拟列表返回 cursor。
- 返回记录级 evidence snippets。
- 不承担 schema 归一化；归一化交给抽取工具或 LLM。

### 6.4 抽取工具

不使用页面级 `extract_data`，改为 target 级：

```text
extract_records(atlas_id, target_id, schema, range?, options?)
```

硬性规则：

- `target_id` 必须来自同一个 `atlas_id`。
- `target_id` 类型必须是 `collection`、`table` 或 `detail_region`。
- schema 必须由 LLM 显式提供，不能只有自然语言任务。
- 返回 JSON records，并附带 evidence。

错误示例：

```json
{
  "task": "extract all prices from this page"
}
```

必须 fail closed：

```text
error: extract_records requires atlas_id and target_id from read_page(mode="atlas").
Call read_page(mode="atlas") first, choose a collection/table target, then retry.
```

## 7. 工具披露策略

不能只靠 prompt 告诉 LLM「先读 atlas」。流程必须由工具协议强制。

### 7.1 初始暴露

第一版推荐只把以下工具作为主要入口：

```text
read_page
find_target
```

如果当前工具系统不支持动态披露，也可以静态暴露全部工具，但 target 级工具必须严格校验 `atlas_id` / `target_id`。

### 7.2 Target 级工具校验

`read_collection`、`read_table`、`read_target`、`extract_records` 必须校验：

1. `atlas_id` 是否存在。
2. `target_id` 是否属于该 atlas。
3. 当前 tab 是否仍匹配 atlas 的 tab。
4. 当前 URL/origin 是否仍匹配，或是否允许 same-origin path drift。
5. target 类型是否支持当前操作。
6. atlas 是否过期。
7. DOM 是否发生明显变化；若变化则要求重新 `read_page(mode="atlas")`。

### 7.3 返回值引导

每个 atlas target 必须包含 `next_actions`，让 LLM 在局部 observation 中看到合法下一步。

工具错误也必须是可恢复的，例如：

```text
target_not_found: target_id does not exist in atlas atlas_7f3.
Call read_page(mode="atlas") again because the page may have changed.
```

## 8. `search_page` 取舍

第一版不建议公开暴露现有 `search_page`。

原因：

- 它会成为绕过 atlas 的捷径，削弱「先地图、后目标、再读取/抽取」流程。
- 若只是字符串搜索，它对操作和结构化抽取的帮助有限，容易返回不具备操作/抽取语义的片段。
- 它可能让 LLM 在目标不明确时直接搜索全文，而不是先理解页面的 action/data surfaces。

保留方向：

- V1：搜索作为 atlas 构建内部 helper，用于发现 label、字段、候选 data surface。
- V1.5：公开 `find_target(atlas_id, query)`，只搜索 atlas targets。
- V2：接入 embedding 后公开 `semantic_search(atlas_id, query, scope?)`，搜索已索引的 targets/chunks，并返回 `target_id` / `chunk_id` / evidence。

语义搜索也必须绑定 atlas：

```text
semantic_search(atlas_id, query, scope?)
```

不应恢复为：

```text
search_page(tabId, query)
```

## 9. Atlas 生命周期

每次 `read_page(mode="atlas")` 生成一个 atlas snapshot：

```ts
interface PageAtlasState {
  atlasId: string;
  tabId: number;
  url: string;
  origin: string | null;
  createdAt: number;
  targets: AtlasTarget[];
  controls: AtlasControl[];
}
```

存储位置可复用 agent loop/session 内存态，不需要第一版持久化。

过期规则：

- tab 不存在：过期。
- origin 改变：过期。
- reload/navigation：过期。
- DOM 指纹与 atlas 构建时明显不同：过期。
- 超过短 TTL：建议过期。第一版建议 2 分钟，避免长任务中旧 target 误用。

DOM 指纹第一版可轻量实现：

- document URL。
- title。
- body text length bucket。
- interactive element count bucket。
- top-level landmark/section count。

## 10. 识别策略

第一版识别策略以启发式为主，避免引入模型内循环。

### 10.1 Controls

来源：

- 原有 interactive index。
- tag/role/type/aria-label/name/placeholder/label。
- fieldset/form/label 关系。
- 相邻文本作为 label fallback。

输出：

- `control_id`。
- `pie_idx`、`frame_id`。
- type、label、value、disabled、checked、selected。
- 所属 form/control group。

### 10.2 Forms 与 Control Groups

识别：

- 原生 `form`。
- 没有 form 标签但 input/select/button 聚集的区域。
- filter/sort/tab/menu toolbar 通过 role、aria、文本和相邻布局聚类。

输出：

- fields。
- submit/reset controls。
- 可能影响的数据 target，例如某筛选器可能作用于 `collection_c1`。

### 10.3 Collections

识别：

- 重复 DOM shape。
- 相同 class/tag 层级的 sibling blocks。
- list/grid/feed role。
- 搜索结果、商品卡、评论卡、issue row、邮件 row 等常见结构。

输出：

- visible record count。
- estimated total，如可从分页/计数文本提取。
- record shape field guesses。
- visible range。
- cursor，如滚动/分页可继续。

### 10.4 Tables

识别：

- 原生 table。
- role=grid/table/row/cell。
- CSS grid/flex 形成的 repeated row/column pattern。

输出：

- columns。
- visible rows。
- sort/pagination/filter controls。
- row range cursor。

### 10.5 Detail Regions

识别：

- label/value pairs。
- definition list。
- profile/detail cards。
- checkout/order/detail pages中的字段密集区域。

输出：

- field guesses。
- evidence snippets。
- 可作为 `extract_records` 的 single-record target。

## 11. 安全与信任边界

- Page content、labels、field values、excerpts、evidence 全部是不可信页面内容。
- atlas 中的页面文本必须继续使用现有 untrusted wrapper escape 策略。
- 工具返回的 `next_actions` 是本地工具生成的建议，不得混入页面文本直接拼接成可执行指令。
- 页面提供的文本即使长得像「请调用某工具」也只能作为 data/evidence。
- `extract_records` 返回的 evidence 必须标注来源 target/record/field，避免把页面文本提升为 system 指令。
- 写操作仍沿用现有风险分类与用户确认机制；Page Atlas 不降低现有确认要求。

## 12. 错误处理

| 情形 | 行为 |
|---|---|
| LLM 直接调用 `extract_records` 且没有 atlas/target | fail closed，提示先 `read_page(mode="atlas")` |
| target 不存在 | fail closed，提示重新读 atlas |
| atlas 过期 | fail closed，提示重新读 atlas |
| target 类型不支持抽取 | 返回 `unsupported_target_type`，附合法 target 类型 |
| collection/table 为空 | 返回空 records + evidence，标注 visible count 为 0 |
| 页面变动导致 cursor 失效 | 返回 `stale_cursor`，提示重新读 target 或 atlas |
| 跨 origin drift | fail closed，沿用任务级 origin 保护 |
| iframe 不可达 | atlas 标注 unreachable frame，不伪造内容 |

## 13. 版本路线

### V1：Atlas + target 级读取/抽取

- `read_page(mode="atlas")`
- `find_target(atlas_id, query)`
- `read_collection(atlas_id, target_id, range?)`
- `read_table(atlas_id, target_id, range?)`
- `extract_records(atlas_id, target_id, schema, range?)`
- `read_page(mode="interactive")` 保留现有操作前读取语义。
- 现有 `search_page` 不公开给 LLM。

### V1.5：更好的 target 定位

- `find_target` 引入轻量 lexical ranking。
- atlas target 与 controls 建立影响关系，例如 filter controls affect collection。
- 更稳定的 collection/table schema guess。

### V2：语义搜索

- 页面 chunks/targets 建 embedding index。
- `semantic_search(atlas_id, query, scope?)` 公开。
- 搜索结果返回 `target_id`、`chunk_id`、snippet、score、evidence。
- 仍不提供无 atlas 的全页搜索入口。

## 14. 测试策略

单测：

- controls/form 识别：label、placeholder、aria、fieldset、非 form 聚类。
- collection 识别：重复 cards、列表 rows、评论/feed。
- table 识别：原生 table、role grid、div table。
- target id 稳定性：同 DOM 多次读取 id 一致；小幅文本变化不导致全量失效。
- `extract_records` 参数校验：无 atlas、错误 atlas、错误 target、过期 atlas、错误 target 类型全部 fail closed。
- `find_target` 只搜索 atlas targets，不返回页面全文。

集成测试：

- 搜索结果页：atlas -> collection -> extract records。
- 后台表格页：atlas -> table -> read rows -> extract records。
- 表单筛选页：atlas -> controls -> 操作筛选 -> 重新 atlas -> collection。
- 虚拟列表页：atlas -> collection -> read_more。
- iframe 页面：frame map 与 unreachable frame 正确标注。

回归测试：

- 现有 `read_page(mode="interactive")` 行为不破坏 click/type/select。
- `untrusted_*` wrapper escaping 不被新 atlas 字段绕过。
- token budget：atlas 输出在常见复杂页面上显著小于 full/content 模式。

## 15. 决策摘要

1. 第一版 Page Atlas 优先服务网页操作和结构化抽取，不以全文问答为核心。
2. `read_page(mode="atlas")` 是入口，返回 action surfaces 与 data surfaces。
3. 抽取工具必须是 target 级：`extract_records(atlas_id, target_id, schema)`。
4. 不公开页面级 `extract_data`。
5. 现有 `search_page` 第一版不公开；搜索先收敛为 `find_target(atlas_id, query)`。
6. 后续语义搜索必须绑定 atlas：`semantic_search(atlas_id, query, scope?)`。
7. 流程不依赖 LLM 自觉遵守，而由 `atlas_id` / `target_id` / fail-closed / `next_actions` 强制表达。

## 16. Implementation Trace

- `read_page(mode="atlas")` implemented in `src/lib/agent/tools/read-page.ts`.
- Page-world atlas heuristics implemented in `src/lib/dom-actions/probe-core.ts` under `op: "atlas"`.
- Atlas state and target validation implemented in `src/lib/agent/tools/page-atlas/state.ts`.
- Target-gated tools implemented in `src/lib/agent/tools/page-atlas/target-tools.ts`.
- Public tool disclosure updated in `src/lib/agent/tools.ts`, `src/lib/agent/tool-names.ts`, and `src/lib/agent/prompt.ts`.
- `search_page` remains importable for unit coverage but is no longer exposed through `BUILT_IN_TOOLS` or prompt guidance in V1.
