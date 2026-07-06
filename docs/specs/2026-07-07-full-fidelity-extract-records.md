# 设计：全保真批量数据抽取 `extract_records`（atlas → scratchpad 直通）

- 日期：2026-07-07
- 状态：设计稿，已与用户逐节评审通过
- 关联背景：长页面大量数据提取时，现状是 LLM 读取页面内容后逐行转录进 scratchpad（`read_struct` → 上下文 → `save_scratchpad`），数据过模型两次：占用上下文 O(行数)、思考中复述数据拖慢推理、转录引入幻觉误差。
- 前置设计：`2026-06-09-page-atlas-progressive-read-design.md`（Page Atlas）、`2026-06-08-scratchpad-long-horizon.md`（scratchpad）

## 1. 背景与问题

现状数据流：

```text
页面 → (atlas 探查) → records 预览 → read_struct → LLM 上下文 → LLM 逐行转录 → save_scratchpad → scratchpad
                                                    ↑ 全部开销与误差都在这一段
```

LLM 在这条链上只扮演「复印机」，但代价是：

- 上下文占用与行数成正比，长任务很快触发裁剪/压缩；
- 模型可能在 thinking 里复述数据，推理时间与成本放大；
- 转录本身是幻觉面，抄错无从校验。

同时，现有 atlas records 是**导航预览级**数据，不能直接管进 scratchpad 充当抽取结果：

- collection records 截 20 条、table 截 25 行（`probe-core.ts` 内 `group.slice(0, 20)` / `visibleRows.slice(0, 25)`）；
- 所有文本经 `SUMMARY_TEXT_MAX = 120` 截断；
- collection 字段只有浅抽取的 `title` / `link` 两项。

所以真正缺的是一条**全保真的二次抽取管道**：结构识别沿用 atlas，抽取结果在 SW 侧直写 scratchpad，数据全程不进 LLM 上下文。

## 2. 目标 / 非目标

**目标**

1. 新增工具 `extract_records`：给定 atlas target，在页面内全保真批量抽取重复结构记录，SW 直写 scratchpad；LLM 只看到计数、字段目录（含覆盖率）与少量样本。
2. 覆盖三类目标场景：
   - 静态长列表/大表格（一页几百上千行，一次抽完）；
   - 无限滚动/虚拟列表（工具内置滚动-抽取-累积循环）；
   - 分页列表（LLM 驱动翻页，每页一次抽取，跨页 dedupe）。
3. 抽取字段采用**自动全抽**（方案 A）：程序化抽出每个重复项的全部叶子文本/链接/图片，语义证据命名，脏字段交给已有 `query_scratchpad` SQL 清洗。
4. 跨调用锚点使用**结构语义签名**（shapeKey + 容器章节上下文 + 类型），不持有元素引用（虚拟列表节点回收会杀死一切 stamp/路径引用）。
5. 任何失败/中断不丢已抽数据（增量落盘）。

**非目标（本期不做）**

- 列表 → 详情页跨页 join（每行进详情页补字段是另一个成本模型的任务）。
- LLM 编写字段映射/selector 的抽取路径（方案 B）；如自动全抽在真机上不够用再补。
- 容器 stamp 快路径优化（先结构签名单一路径，真机慢了再加）。
- 滚动循环内自动翻页（导航决策留给 LLM，符合「LLM 控制终止」哲学）。
- 修改 atlas 探查本身（20/25 cap 与 120 截断是导航预览的合理设计，保持不变）。

## 3. 关键决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| 字段定义 | 自动全抽 + SQL 后清洗（A），弃 LLM 写映射（B） | A 的失败模式可恢复（字段名脏 → 一条 SQL 修，源数据完好）；B 的失败模式要重爬（列错位 → 重滚整个无限列表，可能回不去）。B 依赖「LLM 写对 selector」，对混淆 class 页面脆弱，且 1-2 个样本推映射会静默漏掉稀疏字段。 |
| 跨调用锚点 | 结构语义签名，每次调用重新定位容器 | 虚拟列表/React 重渲染不停销毁重建节点，stamp 属性与 CSS path 活不过一次滚动；shapeKey 识别「形状」，节点换了签名不变。与 `resolveTarget` 用 fingerprint 验新鲜度的既有哲学一致。 |
| 滚动循环归属 | 工具内置（SW 驱动），非 LLM 每步驱动 | 几千行虚拟列表按屏滚 = 上百轮对话，本身就是要消灭的开销。滚动是同页机械动作而非导航决策，内置循环 + 硬限界 + abort 贯穿，不违背「LLM 控制终止」。 |
| 行去重 | `dedupeKey`（LLM 指定，如 link）；缺省自动注入 `_hash`（全字段内容 hash）并以其 dedupe | 滚动重叠区与跨页重访都靠内容级 identity，DOM identity 不可用。复用 scratchpad `saveRecords` 现有 dedupeKey 机制。 |
| 落盘时机 | 每批增量落盘 | abort/崩溃/导航后数据不丢；续抽靠 dedupe 幂等。 |

## 4. 总览与数据流

```text
read_page({mode:"atlas"})          ← LLM 确认页面上有哪个 target（已有能力）
→ extract_records({atlas_id, target_id, collection, dedupeKey?, scroll?, max_rows?})
    SW 内部循环：
      executeScript(probe-core extract op)  → 全保真 records（按行游标分批，≤500 行/批）
      → saveRecords(collection)             → 增量落盘 scratchpad（dedupe）
      → [scroll:true] executeScript(scroll) → 等加载稳定 → 重复，直到停止条件
→ observation：计数 + 停止原因 + 字段目录（覆盖率）+ 2-3 行样本
→ 已有链路：query_scratchpad 清洗 → output_file 导出
```

三种场景只在循环层不同：

- **静态长列表/大表格**：一次调用、不滚动，内部按行游标分批抽完。
- **无限滚动/虚拟列表**：`scroll: true`，内置滚动循环。
- **分页列表**：LLM 点「下一页」后对新页重新 `read_page(atlas)` + `extract_records`；同一 `collection` + 同一 `dedupeKey` 保证跨页去重。

## 5. 工具 API 与 observation

```ts
extract_records({
  atlas_id: string,      // 沿用 resolveTarget freshness 校验体系
  target_id: string,     // 仅接受 collection / table 类型 target
  collection: string,    // scratchpad 集合名
  dedupeKey?: string,    // 行身份字段；缺省自动注入 _hash 并以其 dedupe
  scroll?: boolean,      // true 开启内置滚动循环；默认 false
  max_rows?: number,     // 默认 2000（硬上限防失控）
})
```

observation（成功示例）：

```text
Extracted from "商品列表" into "products": added 1,943, skipped 156 (duplicates), total 1,943.
Scrolled 87 screens; stopped: no new items after 3 scrolls.
Fields (coverage): title 100% · link 100% · price 98% · rating 71% · badge 12%
Sample: <untrusted_scratchpad_preview>[{...},{...}]</untrusted_scratchpad_preview>
```

**字段覆盖率是校验设计的核心**：LLM 不看全量数据，靠「字段目录 + 每字段非空占比 + 样本」判断抽取质量（badge 12% 是正常稀疏字段还是抽错，看样本即知），不满意可换 target 重抽或退回手工路径。

## 6. 页面内抽取引擎（probe-core 新增 `extract` op）

与 atlas 探查同住 `probe-core.ts`（复用 shapeKey / safeText / sanitize / 安全 href 等基建），独立的全保真路径：

- **定位**：extract op 入参携带 target 的结构签名（shapeKey + 容器章节上下文 + 类型），每次调用重新定位容器；同构容器多个时按签名 + 上下文消歧。签名失配 → 返回 `target_stale`。执行 frame 取 atlas target 已记录的 `frameId`（`AtlasTarget.frameId`），不引入新的 frame 逻辑。
- **slot 目录（字段命名）**：抽取前先扫当前可见条目集合建 slot 目录：
  - table：列头文本为字段名（无 thead 时退回首行 th / `Column N`，沿用现有逻辑）；
  - collection：按语义证据命名（标签角色、heading 层级、链接/图片角色、`aria-*`），class 词干仅作 tiebreaker，序号兜底。
  - 同一 slot 跨条目、跨滚动步、跨页名字稳定；条目缺 slot = 空值，不漂移；中途出现新形态条目 → slot 动态加入目录，旧行该字段为空。
- **保真度**：字段值不做 120 截断；单字段上限 ~2KB，超出截断并尾标 `…[truncated]`，行照存。
- **分批**：单次 executeScript 按行游标最多返回 ~500 行，SW 循环拉批，静态大表不会撑爆消息序列化。

## 7. 滚动循环（SW 侧驱动）

`scroll: true` 时 SW 内循环：抽当前渲染条目 → 落盘 → 滚一步（步长 ≈ 视口高度 80%，保留重叠区防虚拟列表跳行）→ 等加载稳定（内容高度变化/静默窗口）→ 重复。

停止条件（先到先停，原因写入 observation）：

1. 连续 3 步无新增（dedupe 后 added = 0）；
2. 达到 `max_rows` 或滚动步数硬上限；
3. 总时长上限（防无限流页面永不收敛）；
4. 用户 abort（贯穿现有 abort signal；增量落盘保证已抽数据不丢）；
5. 页面导航离开 / tab 关闭 / 容器签名丢失 → 返回部分结果 + 错误说明。

## 8. 错误处理与兜底

| 情况 | 行为 |
|---|---|
| atlas 无合适 target（页面结构太散） | LLM 走手工兜底路径（read_struct / read_page + save_scratchpad 转录，即现状流程）；skill playbook 明确这是降级路径 |
| 结构签名失配（页面变了/SPA 切换） | 报 `target_stale`，提示重新 `read_page({mode:"atlas"})`；不静默重猜 |
| 滚动中容器被整体替换 | 循环终止，部分结果保留，停止原因 `container_lost` |
| 字段参差（部分条目缺 slot） | 空值填充，不算错误；覆盖率暴露给 LLM |
| 单字段超 2KB | 截断 + `…[truncated]` 尾标，行照存 |
| executeScript 失败（受限页/frame 销毁） | 与现有工具同路径报错；已落盘数据保留 |

原则：**任何失败都不丢已抽数据**；错误信息给 LLM 足够信号决定重试/换路径/收工；终止决策权在 LLM/用户，工具只按硬限界自保。

## 9. 安全与信任边界

- 字段值与字段名（列头/证据文本均页面派生）全部过 `escapeUntrustedWrappers` + 现有 sanitize；href 过 `safeLinkHref` 的 UNSAFE_URL 过滤。复用 probe-core 现有管道，不开新逃逸口。
- 样本回显包 `<untrusted_scratchpad_preview>`（与 read_scratchpad 一致）；scratchpad 读回路径已有包裹，不变。
- 落盘的是原始页面数据（untrusted），但不经 LLM 转录——注入内容只能躺在数据行里，进 prompt 必经包裹读回。相比现状缩小注入面。
- `tool-names.ts`：`extract_records` 声明为 **write-class**——虽然对页面只滚视口（`scroll` 本身是 read），但它写 scratchpad IDB，与 `save_scratchpad` 归类逻辑一致（mutate IDB state → write）。write-class 意味着 R7 跨 session 锁对其生效，对一个长时间持有 tab 的滚动抽取来说正是想要的语义。R-iframe-1（write tool 须 require frameId）是 type/select/click/hover 的固定清单断言，不涉及本工具。

## 10. 测试策略

- **抽取引擎单测**（happy-dom 构造 DOM）：table（有/无 thead、th 首行）、卡片 collection（参差字段、嵌套链接/图片）、slot 命名跨条目一致性、2KB 截断、wrapper 注入 escape、UNSAFE href 过滤。
- **签名重定位**：同构容器多个时选对；页面变更后 `target_stale`。
- **滚动循环单测**（mock executeScript 序列）：停滞检测（3 步无新增）、max_rows 截停、abort 中断且已落盘、`container_lost` 部分返回、dedupe 幂等（同批重复/跨步重叠）。
- **跨层测试**：extract_records → scratchpad 落盘 → read_scratchpad 读回包裹完整；`_hash` 自动 dedupe 路径。
- **build-time invariant**：tool-names read/write 分类声明存在。

## 11. 配套改动

1. `extract_structured_data` skill playbook：Collect 段首选 `read_page(atlas) → extract_records`；手工转录降级为兜底；分页模式写明「LLM 翻页 + 每页一次 extract_records + 同 dedupeKey」。
2. `save_scratchpad` / `read_struct` description 互指（「target 可见时用 extract_records，别转录」）。
3. `read_struct` 保留现状（小量数据读回上下文的场景仍需要）。
4. atlas 探查本身不动。

## 12. 默认值汇总（实现时可调，出厂值如下）

| 参数 | 默认值 |
|---|---|
| `max_rows` | 2000 |
| 单批行数（executeScript 返回上限） | 500 |
| 停滞判定 | 连续 3 步 added = 0 |
| 滚动步长 | 视口高度 × 0.8 |
| 单字段值上限 | 2KB |
| 滚动步数硬上限 | 200 |
| 循环总时长上限 | 120s |
