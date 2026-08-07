# ReadPage Token 效率：从“返回页面”改为“检索任务证据”

日期：2026-08-07  
状态：研究结论与实施建议  
范围：`read_page` / Atlas 的返回体、页面内检索、上下文生命周期与 KV cache；不讨论具体模型价格

## 结论摘要

仅靠 progressive disclosure 解决不了 ReadPage 的 token 飞涨。它只规定“先看摘要、再按需展开”的调用顺序，却没有约束三个真正的乘数：

1. **一次捕获多少对象**：Atlas 当前会完整枚举 controls 和 targets，`max_bytes` 对 Atlas 实际无效。
2. **多少内容被送进模型**：页面数据没有先按任务、区域、字段和证据相关性做选择；同一信息还会被多种格式重复序列化。
3. **结果在多少轮请求中继续驻留**：大结果第一次暴露必然产生输入 token；如果后续多轮保留，逻辑输入量会继续累积。KV cache 只能摊薄部分重复 prefill 成本，不能缩小上下文，也救不了第一次暴露。

推荐把页面视为一个**保存在模型上下文之外、带 revision 的本地语料库**。模型默认只接收 token 有硬上限的“任务视图”：页面摘要/区域地图、与当前意图最相关的少量控件或原文证据，以及可定点回读的稳定引用。完整 DOM、全量 records 和全量 controls 不再是默认工具结果。

优先级应是：

> **先减少对象基数和选择范围，再优化序列化，再做有损压缩，最后才讨论 KV cache。**

这一方向不仅能降低 token。长上下文研究表明，加入更多上下文并不保证模型更好地使用它，相关信息位于中间时性能还可能下降；因此，相关性选择和证据定位有机会同时改善成本与任务效果。[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/)

## 当前实现中的主要放大器

以下结论来自本分支代码核查；行号对应 2026-08-07 的工作区状态。

### 1. Atlas 没有执行结果预算

`read_page` 在 [`read-page.ts:236`](../../src/lib/agent/tools/read-page.ts#L236) 计算了 `totalBudgetBytes`，但 Atlas/auto 分支 [`read-page.ts:258`](../../src/lib/agent/tools/read-page.ts#L258) 到 [`read-page.ts:321`](../../src/lib/agent/tools/read-page.ts#L321) 从未使用它。`max_bytes` 因此只限制 snapshot HTML，不限制默认 Atlas 返回体。

Atlas renderer 又会遍历**全部** forms、controls 和 targets，[`render.ts:45`](../../src/lib/agent/tools/page-atlas/render.ts#L45) 到 [`render.ts:107`](../../src/lib/agent/tools/page-atlas/render.ts#L107) 没有 count/token cap、viewport/query 过滤或 cursor；每个 target 还重复输出一组 `next_actions`。

直接后果是：progressive disclosure 的第一层本身就可能是一个 1–3 万 token 的结果。

### 2. Snapshot mode 没有真正分离返回面

snapshot 分支无论 `interactive`、`content` 还是 `full`，都会构造 interactive index，并在随后追加 HTML blocks，[`read-page.ts:459`](../../src/lib/agent/tools/read-page.ts#L459) 到 [`read-page.ts:466`](../../src/lib/agent/tools/read-page.ts#L466)。mode 主要改变 byte cap，而不是“只返回交互控件”或“只返回正文”。这与 prompt 中的模式说明不一致，导致模型即使正确选择较轻模式，也仍可能收到不需要的内容。

### 3. Atlas 的内容覆盖面不足，迫使文章页退回大正文

probe 目前只生成 table 和 collection targets，[`probe-core.ts:1175`](../../src/lib/dom-actions/probe-core.ts#L1175) 到 [`probe-core.ts:1299`](../../src/lib/dom-actions/probe-core.ts#L1299) 没有 `region` / `detail_region`。文章、详情页和普通正文没有可定点读取的目标，只能退回 `mode:"content"`，这会把成本从“局部证据”重新放大成“整页正文”。

### 4. Atlas 已含动作坐标，却要求再读一次 interactive

每个 Atlas control 已含 `frameId` 与 `pieIdx`，[`types.ts:37`](../../src/lib/agent/tools/page-atlas/types.ts#L37) 到 [`types.ts:46`](../../src/lib/agent/tools/page-atlas/types.ts#L46)。但 prompt 仍要求 click/type/select 前重新执行 interactive read，[`prompt.ts:257`](../../src/lib/agent/prompt.ts#L257) 到 [`prompt.ts:267`](../../src/lib/agent/prompt.ts#L267)。这制造了一次可避免的重复页面暴露。

应让 Atlas 的 `control_ref` 直接可执行；只有 revision 已变化或 ref 失效时才增量刷新。

### 5. Records 同时重复内容并膨胀 JSON

[`target-tools.ts:231`](../../src/lib/agent/tools/page-atlas/target-tools.ts#L231) 到 [`target-tools.ts:243`](../../src/lib/agent/tools/page-atlas/target-tools.ts#L243) 对每条 record 同时输出：

- `fields` JSON；
- 通常由相同字段拼成的 `text`；
- `evidence`。

字段投影路径又把 JSON 整体做 XML escaping，[`target-tools.ts:246`](../../src/lib/agent/tools/page-atlas/target-tools.ts#L246) 到 [`target-tools.ts:255`](../../src/lib/agent/tools/page-atlas/target-tools.ts#L255)，使所有双引号变为 `&quot;`。

合成测量（25 rows × 8 fields、值约 10 字符）显示：当前 `renderRecords` 形态约 13,507 chars / 3,377 tokens；只保留 JSON fields 与紧凑 source/range 约 4,815 chars / 1,204 tokens，约缩小 **2.81×**。单字段投影的当前 escaped JSON 为 2,066 chars，raw JSON 为 1,066 chars，escaping 单独造成约 **1.94×** 膨胀。这里的 token 为 `chars/4` 粗估，目的是比较相对大小，不是 provider 账单值。

outer untrusted wrapper 内可以直接放 neutralize wrapper tags 后的 JSON；默认使用 range/budget/cursor，不再默认全量；`text` 与 `evidence` 应移除重复内容，或仅保留 compact source ref。

### 6. 重复集合既进入 records，又进入 global controls

collection/card 中的每个 link/button 既可能成为 collection record，又会全量进入 global controls。重复模板页面因此按记录数成倍增长。更合适的表达是：按 form/collection/navigation 分组并去重，只输出一次模板 action，加上各 record 的轻量 ref；仅对 top-K 或当前 viewport 的具体实例展开动作坐标。

### 7. 基于字符串的 stale elision 会误删可持久证据

stale observation 通过是否包含 `<untrusted_page_content` 判断是否为大 snapshot，[`elide-stale-observations.ts:40`](../../src/lib/agent/elide-stale-observations.ts#L40) 到 [`elide-stale-observations.ts:60`](../../src/lib/agent/elide-stale-observations.ts#L60)。但 `read_struct`、`read_target`、`find_target` 也使用相同 wrapper，[`target-tools.ts:223`](../../src/lib/agent/tools/page-atlas/target-tools.ts#L223) 到 [`target-tools.ts:228`](../../src/lib/agent/tools/page-atlas/target-tools.ts#L228)。这些本应比 snapshot 更值得保留的任务证据，进入旧轮次后也会被替换成 stale marker。

现有测试使用了实现中不存在的 `<untrusted_struct_records>` wrapper，因而没有覆盖真实路径。应把保留策略放进 typed tool result，而不是从文本 marker 推断。

### 8. 现有预算单位与目标单位不一致

页面工具限制的是 UTF-8 bytes；对话窗口则用全局字符比例粗估 token，[`window-token-budget.ts:1`](../../src/lib/agent/window-token-budget.ts#L1) 到 [`window-token-budget.ts:16`](../../src/lib/agent/window-token-budget.ts#L16)。同样的 byte cap 对英文、中文、HTML escaping、URL 和 JSON 标点会产生很不一样的 token 数。

工具结果必须有 provider/model-aware token 估计或安全上界，并对 `action_surfaces`、data、正文等分段计数。provider 的 token counting API 可用于 canary 校准，但它本身也是模型相关的估计接口。[Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)

## 基数比序列化格式更重要

本地合成测试说明了问题的量级：

| 页面形态 | 当前近似体积 | 观察 |
|---|---:|---|
| 300 controls | 32,357 chars / 8,090 tokens | Atlas 第一层已很大 |
| 200 cards、400 controls | 38,105 chars / 9,527 tokens | collection 与 controls 双重增长 |
| 1,000 controls | 107,261 chars / 26,816 tokens | `action_surfaces` 单段 106,710 chars，几乎占全部 |
| 同一 1,000 controls，改 compact arrays | 约 10,946 tokens | 仅换序列化仍然很大 |
| 同一页面，只返回 top-40 controls | 约 416 tokens | 先降基数带来数量级收益 |
| 12 tables、每表 25×8 | LLM wire 约 2,004 tokens；probe JSON 117,227 chars | 即使 records 暂未全部上 wire，也有注入/内存成本 |

这些是 synthetic estimate，不代表真实页面总体分布；但方向非常清楚：**top-K、区域/viewport、query 和 cursor 的收益远大于 XML 换 JSON。**

## 为什么“大窗口 + KV cache”不是解法

需要分开看四个量：

- `logical_input_tokens`：本次模型实际可见的完整上下文；
- `uncached_input_tokens`：需要新做 prefill 的部分；
- `cache_read_tokens` / `cache_write_tokens`：provider 对精确前缀复用的统计；
- client wire bytes：本地与 API 间传输体积。

Anthropic 和 OpenAI 的 prompt caching 都要求共享稳定前缀；在变化点之前的任何改动都会影响后续 cacheability。Anthropic 的匹配顺序是 tools → system → messages，usage 将 input 分成 `cache_read_input_tokens`、`cache_creation_input_tokens` 与其余 `input_tokens`。OpenAI 当前文档同样要求精确 prefix、静态内容在前、动态内容在后，并分别报告 `cached_tokens` / `cache_write_tokens`；动态尾部的隐式断点并不保证命中，稳定前缀应使用适用模型支持的显式断点。这些是截至本文日期的 provider 行为，接入时仍应以对应模型文档为准。[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) vLLM 的 Automatic Prefix Caching 也明确只减少共享前缀的 prefill，不减少 decode，且没有共享前缀时无效。[vLLM APC](https://docs.vllm.ai/en/v0.22.1/features/automatic_prefix_caching/)

因此：

- 巨大页面结果**第一次**进入模型时一定是 cache miss；
- 结果即使 cache hit，仍然占上下文窗口，也仍可能产生 lost-in-the-middle 干扰；
- 当前随机/时间型 `atlas_id` 和不稳定排序会降低同页重读时的前缀一致性；
- conversation/response ID 主要省状态传输，并不等于免除历史输入 token。OpenAI 文档明确说明，使用 `previous_response_id` 时链上之前的输入仍计入 token。[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

建议同时报告 cache hit ratio 与 uncached input tokens，但把“避免把无关内容送进模型”设为第一目标。Anthropic 的 context management 文档也明确区分：prompt caching 降低重复计算/费用，但不会减少上下文中的 token。[Manage tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context)

## 推荐架构：Page Store + Token-bounded Task View

### 1. 页面驻留在模型之外

浏览器侧为每个页面 revision 保存：

- `page_ref`、URL、内容 hash / `revision`；
- heading/landmark/region 树；
- chunks、records、controls 与稳定 ID；
- source offsets / DOM locator / frame；
- lexical index，后续可选 embedding index；
- 原始证据和已缓存的页面级摘要。

模型只看引用、摘要和被选中的证据。`file_id` 或 resource URI 本身并不会神奇地省 token：只有模型不同时接收完整资源内容时，handle 才有意义。Anthropic Files API 也说明，被 Messages 引用并实际处理的文件内容仍按输入 token 计算。[Files API](https://platform.claude.com/docs/en/build-with-claude/files)

MCP 的 resource model 可作为协议参考：工具返回轻量 `ResourceLink`，资源按 URI 读取，列表支持 cursor pagination；但 MCP 为兼容性建议 structured result 同时返回序列化 TextContent，若客户端把两份都注入模型，反而会重复 token。[MCP resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

### 2. 先按意图选择 representation profile

| 意图 | 默认表示 | 不应默认返回 |
|---|---|---|
| 点击、输入、选择 | viewport/region 内的 AX/interactive controls；query/role/name 过滤 | 全页所有 controls + 正文 |
| 文章阅读、问答、摘要 | Readability 主内容、heading outline、section chunks | navigation、重复 footer、全 DOM |
| 表格/列表/邮箱/卡片 | schema、count、少量 sample、records handle；按 fields/range 查询 | 默认全量 records |
| 页面概览、意图未知 | landmarks/regions 的 page digest + omitted counts | 猜测用户未来需要而预载全文 |
| 精确核对数字、URL、代码、引文 | 带 source ref 的 extractive spans | 只有不可追溯的抽象摘要 |

Mozilla Readability 能从文章页提取处理后的 article HTML、纯文本、标题、作者等元数据，适合作为正文 profile；它的 readerability 判断允许 false positive/negative，所以不能取代通用 fallback。[Mozilla Readability](https://github.com/mozilla/readability)

交互 profile 可利用浏览器 Accessibility Tree。CDP 同时提供 full、partial 和按 accessible name/role 查询 AXTree 的接口，AXNode 还带 `backendDOMNodeId`；这支持 region/query-scoped 交互读取，而不是每次枚举全树。[Chrome DevTools Protocol Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)

若 Page Store 需要比 live DOM traversal 更统一的捕获原料，CDP DOMSnapshot 可以一次获得跨 iframe/template 的 DOM、layout 与 shared string table；它适合留在浏览器侧做索引与增量比较，不适合未经选择直接喂给模型。[Chrome DevTools Protocol DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/)

Mind2Web 的官方工作说明 raw HTML 经常过长，先用小模型筛候选元素再让主模型选择；其公开 candidate generator 报告 Recall@50 约 85%。这说明候选筛选是可行方向，也提醒 top-K 需要召回兜底，而不能直接硬截断。[Mind2Web paper](https://arxiv.org/abs/2306.06070) [Mind2Web repository](https://github.com/OSU-NLP-Group/Mind2Web)

### 3. 工具协议显式表达预算、遗漏和回读

一个可落地的协议草图：

```ts
inspect_page({
  tab_id,
  intent,            // act | read | extract | overview
  query?,
  budget_tokens
}) => {
  page_ref,
  revision,
  kind,
  digest,
  regions,
  controls?,         // bounded top-K
  omitted: { regions, controls, records, tokens },
  next
}

query_page({
  page_ref,
  revision?,
  query,
  scope?,
  top_k?,
  budget_tokens,
  evidence: "extractive"
}) => {
  evidence: [{ chunk_id, heading_path, source_range, text }],
  omitted,
  cursor?,
  next
}

read_page_chunks({
  page_ref,
  chunk_ids?,
  range?,
  fields?,
  cursor?,
  budget_tokens
})

act_on_page({ control_ref, revision, action, value? })
```

所有路径都必须满足：

- hard token cap，而非只限制 bytes；
- 达到上限时返回 omitted counts、cursor 和明确的 next action；
- 不把截断后的半个 record/HTML tag 当成完整证据；
- source ref 稳定、可定点回读；
- revision 变化时明确返回 stale ref，而不是静默点击错误元素。

初始预算可把默认单次工具结果设为 `min(2k tokens, remaining_context × 5%)`，hard cap 先设 4k，再用评测校准。这里是待验证的工程起点，不是研究结论。

### 4. 检索优先，压缩后置

推荐流水线：

1. 确定性清理 DOM boilerplate、隐藏资源和重复模板块。
2. 构建 page map：heading、region、chunk ID、类型和 token 数。
3. 支持 `need-to-read` gate：页面对当前任务没有增量证据时只返回 metadata/unchanged。
4. 用 query 对 section/chunk 做 hybrid retrieval：BM25/exact match + 可选 contextual embedding。
5. rerank 后应用动态 top-K 与硬 token budget。
6. 默认返回带 offset 的 extractive spans。
7. 仍超限时才做 query-aware summary 或 token compression。
8. 将数字、实体、URL、代码、表格单元格和引文标为 protected spans。

LongLLMLingua 的 coarse-to-fine、question-aware 压缩和重排，在 NaturalQuestions 的特定设置中以约 4× 更少 token 带来最高 21.4% 提升；LongBench 的平均 prompt 从 10,295 降到 1,822 tokens 时，论文报告平均分反而上升。其限制同样重要：不同 query 需要重新压缩，复杂的隐含关联可能在粗筛阶段丢失。[LongLLMLingua](https://aclanthology.org/2024.acl-long.91/)

RECOMP 更值得借鉴的能力是 selective augmentation：若检索结果没有帮助，可以返回空内容。其训练后压缩器在开放域 QA 中能大幅缩短上下文，但多跳场景的抽象摘要更容易遗漏或不忠实，因此不能把“低至 6%”误写成通用无损成绩。[RECOMP paper](https://openreview.net/forum?id=mlJLVigNHp) [RECOMP repository](https://github.com/carriex/recomp)

如果需要更好的小 chunk 召回，可评估 Late Chunking 或给 chunk 增加短的文档内定位上下文；它们不直接压缩 token，而是通过提高 retrieval recall，让较小 top-K 更安全。[Late Chunking](https://arxiv.org/abs/2409.04701) [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)

token-level compression 应放在最后一层。LLMLingua 在 GSM8K 特定实验中可做到 20×、约 1.5 分下降，但 BBH 在 7× 时下降约 13.2 分；论文结果不能外推为通用网页无损倍率。[LLMLingua](https://aclanthology.org/2023.emnlp-main.825/) 对 ReadPage，token pruning 尤其可能破坏实体拼写、URL、数字、代码和 DOM/action 结构。

### 5. Typed lifecycle：大结果只存活一个推理轮次

工具结果应携带机器可读的生命周期，而不是依赖 XML 字符串：

```ts
type PageResult = {
  kind: "page_snapshot" | "page_evidence" | "page_receipt";
  retain: "one_turn" | "until_revision_change" | "task";
  page_ref: string;
  revision: string;
  payload: unknown;
};
```

- `page_snapshot`：默认 `one_turn`。主模型消费一次后，替换成 receipt。
- `page_evidence`：按任务保留少量引用和结论，原文仍在本地 store。
- `page_receipt`：`{page_ref, revision, query, chunk_ids, short_findings}`，用于后续回读。
- 同 revision 重读时优先返回 `unchanged` 或 delta。

可用下面的指标理解生命周期成本：

```text
logical_read_footprint
  = Σ(result_tokens × 该结果继续出现在多少次后续模型请求中)
```

provider 原生的 context editing/compaction 可作为补充；核心保留策略仍应在客户端 typed protocol 中实现，保证跨 provider 一致。Anthropic 的 context editing 会把旧 tool results 替换为 placeholder；OpenAI Responses API 提供 compaction 来缩小后续上下文。[Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)

对于“读取大量 records → 本地过滤/聚合 → 只把结果交给模型”的 fan-out 工作流，也可评估 programmatic tool calling。Anthropic 在一个 75-tool 内部 benchmark 中报告 billed input 降低 38% 且准确率不变，但单次/顺序工作流可能更贵；这属于 provider-specific 优化，不能替代跨 provider 的 page store。[Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)

## 分阶段实施

### P0：先止血并建立可观测性

1. 让 Atlas 真正执行 token/count budget；controls/targets 默认 viewport + top-K + cursor。
2. 让 interactive/content/full 各自只返回声明的表示面。
3. Atlas controls 直接生成可执行 `control_ref`，移除无条件 interactive reread。
4. 修复 typed stale-elision：target evidence 不应因共享 wrapper 被误删。
5. records 默认 range/fields/cursor；消除 `fields` / `text` / `evidence` 重复和整段 XML escaping。
6. collection/template 与 global controls 去重。
7. 分段记录 raw bytes、serialized chars、estimated/provider tokens、omitted count 和 first-exposure uncached tokens。

### P1：引入 Page Store 协议

1. `page_ref + revision + stable region/chunk/control ref`。
2. Atlas 变为 page digest/region map，不再是全量对象清单。
3. 大结果消费一轮后替换为 receipt；同页返回 unchanged/delta。
4. 全链路稳定排序和确定性 serialization，提升本地复用与 prefix cache 机会。

### P2：补足内容 profile 与检索

1. 增加 article/detail/region targets；文章走 Readability + heading chunks。
2. 本地 lexical/exact-match baseline；再评估 embedding/reranker。
3. query-aware extractive evidence；summary 只负责导航，不替代精确证据。
4. 可选评估 LongLLMLingua、RECOMP、Late Chunking；不得直接采用论文中的压缩倍率。

### P3：评测后逐步放量

按页面类型和任务类型 canary；任何 token 降幅都必须同时报告质量、fallback 和证据召回。不要只报告 KV cache hit ratio。

## 评测设计与发布门槛

### 页面集

- 300 / 1,000 controls 的密集表单；
- 重复 cards、链接和按钮；
- 多表格、虚拟列表、分页列表；
- 长文章、详情页、文档站；
- SPA 动态更新、iframe、shadow DOM；
- 中文、英文及混合文本。

### 任务集

- 定位并执行动作；
- 页面问答与精确引用；
- 指定字段/范围的结构化抽取；
- 多跳或跨 section 综合；
- 页面无相关信息时正确停止；
- revision 变化后的 stale ref 恢复。

### 指标

| 维度 | 指标 |
|---|---|
| 质量 | task success、exactness、citation/source fidelity、action grounding |
| 召回 | target/evidence recall@token budget、position robustness |
| 成本 | first-exposure uncached tokens、logical input、cache read/write、output tokens |
| 生命周期 | payload 存活轮数、累计 logical footprint、compaction/elision 后大小 |
| 行为 | fallback/escalation rate、empty-return precision/recall、stale recovery |
| 本地开销 | probe/parse/index latency、内存、压缩器 token/算力成本 |

必须做 evidence-position sweep，避免只测答案位于页面开头的样本。还应比较四条基线：当前实现、P0 止血、Page Store + retrieval、可选 learned compression。

发布门槛应是任务成功率与 evidence recall 非劣、严重错误不增加，同时显著降低 first-exposure 和多轮累计 token。单纯降低平均值但让长尾页面静默漏证据，不算成功。

## 不建议作为主方案的做法

- **只把 500 KB cap 调小**：单位不对，也无法约束 Atlas 对象基数。
- **只把 XML 改为 JSON/数组**：能省常数项，但 1,000 个对象仍然是 1,000 个对象。
- **只优化 KV cache hit ratio**：首次暴露永远 miss，cache 也不缩小上下文。
- **只返回 file/resource handle 后再把全文附上**：省传输管理，不省模型实际读取的 token。
- **对全文做固定倍率的盲目摘要/token pruning**：没有跨网页任务无损的证据，精确数据和动作结构风险尤其高。
- **静默截断**：模型无法知道遗漏量，也无法规划下一次定点读取。
- **同时注入 structured 与等价 text 两份结果**：结构化返回便于验证和局部投影，本身并不自动节省 token。

## 最终建议

这项工作的中心不应叫“压缩 ReadPage 输出”，而应叫“**页面任务视图与证据检索**”。

短期先修 Atlas budget、模式语义、重复序列化、control 重读和 typed lifecycle，预计可直接消除当前最明显的数量级浪费。中期用 page store、region/chunk refs 和 query-aware retrieval 把全文保留在模型之外。只有在这些确定性选择完成后，才在长纯文本尾部评估 learned compression；KV cache 则作为稳定前缀下的额外收益单独度量。

这样既能压低首次工具结果，也能降低多轮驻留成本，同时保留精确回读和失败兜底，最符合“尽量节省 token 且不影响模型效果”的目标。

## 术语补充：Page Store 是什么，哪些部分有标准依据

### 先回答：它不是现成的行业标准组件名

截至本次核验，MCP、Chrome DevTools Protocol、WebDriver、HTTP 和 RAG 原始论文都没有把 `Page Store` 定义为一个通用、可互操作的标准组件。因此本文中的 **Page Store 是 ReadPage 架构的内部工作名，不应对外宣称为行业标准**。

`page-store` 这个词并非从未出现。2025 年的 General Agentic Memory（GAM）预印本用它表示“保存完整 agent 历史 page 的数据库”，再由 researcher 按在线请求检索；这个 page 是装饰后的历史 session，不是浏览器页面、DOM 或交互对象。[General Agentic Memory](https://arxiv.org/abs/2511.18423) 这只能说明有独立工作采用了相似命名和“完整数据外置、运行时检索”的思路，不能给我们的组件提供标准地位或协议兼容性。

该名称还存在明显的跨领域碰撞：FirstSpirit 把 Page Store 用作 CMS 的 editorial pages/sections 内容区；Apache Wicket 的 `IPageStore` 则存储服务器端 page instances。两者彼此以及与 ReadPage 的语义都不同。[FirstSpirit Page Store](https://docs.e-spirit.com/odfs/edocs/fsar/page-store/index.html) [Apache Wicket IPageStore](https://nightlies.apache.org/wicket/apidocs/9.x/org/apache/wicket/pageStore/IPageStore.html) 这进一步说明它是常见的描述性命名，而不是统一的行业构件。

如果名称需要进入公开 API，建议使用更不易误解的 **ReadPage Page Resource Store** 或 **Page Context Store**；内部简称仍可保留 `Page Store`。

### 在 ReadPage 中的严格定义

> **ReadPage Page Store 是一个浏览器侧、版本化、权限受限的页面资源层。它捕获并保存页面的可回读表示，为内容和控件分配引用，维护 revision 与索引，并按 query、scope、range 和 token budget 返回任务相关证据；完整资源默认不进入模型上下文。**

最小数据模型应明确区分逻辑页面、不可变版本和资源引用：

```ts
type PageResource = {
  page_ref: string;       // 本地 opaque identity，不等同于 URL
  revision: string;       // 对该捕获版本的 opaque validator/hash
  tab_id: number;
  top_document_id: string;
  url: string;
  captured_at: string;
  representations: {
    digest: PageDigest;
    regions: RegionTree;
    article_chunks?: Chunk[];
    structured_targets?: Target[];
    controls?: Control[];
  };
};

type PageResourceRef = {
  page_ref: string;
  revision: string;
  kind: "region" | "chunk" | "record" | "control";
  id: string;
  source_locator?: unknown;
  token_estimate?: number;
};
```

其中：

- `page_ref` 标识本地捕获的逻辑页面资源，不能只用 URL；同一 URL 可能因用户、时间、筛选条件而有不同内容。
- top-level document navigation 创建新的 page identity；SPA/in-document 更新可以保留 `page_ref`，但必须生成新的 `revision`。
- `revision` 固定一个不可变捕获版本。若任一对模型可见的内容或 action mapping 变化，就需要新 revision；后续可以用 subresource revision 缩小失效范围。
- `content_ref` 固定到某个 revision，只要该版本尚未被 eviction，就可继续用于引用和审计。
- `control_ref` 同时受 revision 与 live document 生命周期约束；执行前必须验证，失效时返回 typed `stale_control_ref`，不能猜测性复用。
- Page Store 只向模型返回 metadata、digest、bounded evidence 或 receipt；引用不等于把其指向的完整内容自动加入 prompt。

### 功能边界

| Page Store 负责 | Page Store 不负责 |
|---|---|
| 从浏览器捕获 DOM/layout/AX/正文/structured targets | 决定最终答案或代替模型推理 |
| 清理、分区、chunk、去重和稳定排序 | 充当 provider KV/prompt cache |
| 保存 raw evidence、source locator 和不可变 revision | 充当 HTTP browser cache 或网络响应缓存 |
| lexical/exact-match 索引；可选 embedding/reranker | 强制使用某一种向量数据库或 learned compressor |
| query/scope/fields/range/cursor/token budget 读取 | 默认把整份资源注入上下文 |
| `page_ref` / content ref / control ref 与 stale 校验 | 保证网页在捕获之后仍是最新状态 |
| revision change、delta/unchanged 与版本 eviction | 直接执行 click/type/select；动作仍由 executor 负责 |
| 按 tab、origin、用户权限隔离资源 | 跨权限边界持久化或上传敏感页面 |

因此它不是“把 Atlas 搬进一个 Map”这么窄，也不是“通用 agent memory”这么宽。它是 **ReadPage capture 与 LLM context 之间的资源和检索边界**。

### 成熟技术分别支撑什么

下表把“直接依据”和“架构类比”分开。这里的“直接”表示来源明确标准化或展示了该项机制，并不表示来源定义了完整 Page Store。

| 一手来源 | 对 Page Store 的直接依据 | 不能从来源推出、仅是我们的组合/类比 |
|---|---|---|
| [MCP Resources 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) | Resource 由唯一 URI 标识；`resources/list` 支持 cursor pagination；按 URI `resources/read`；可选 `listChanged`、按资源 subscribe/update；resource metadata 包含 name/description/mimeType/size | MCP 不规定资源存储引擎、页面 chunk 算法、相关性排序、token budget 或模型必须何时载入资源 |
| [MCP Tools 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | 工具结果可以返回带 URI、metadata/annotations 的 `resource_link`，由客户端后续 fetch 或 subscribe | ResourceLink 本身不节省 token；只有客户端不立即展开完整资源、按需读取时才节省。工具返回的 link 也不保证出现在 `resources/list` |
| [Anthropic Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 官方工程文章明确描述 just-in-time context：先保留 file path、stored query、web link 等轻量 identifier，再用工具在运行时加载；可用 targeted queries、head/tail 避免整对象进入上下文 | 这是 context engineering 模式和产品经验，不是存储/版本协议，也没有规定 browser page 的 ref、revision 或 stale semantics |
| [RAG, NeurIPS 2020](https://papers.neurips.cc/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html) | 原始 RAG 把 dense Wikipedia index 作为显式 non-parametric memory，并在生成时检索 passage；论文也把可更新知识和 provenance 作为动机 | 该实验是训练后的 dense retriever + Wikipedia，不直接验证 live DOM、网页动作、token-bounded tool result 或我们的本地索引实现 |
| [CDP DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/) | `captureSnapshot` 可取得包含 iframe、template、flattened shadow DOM 的完整 DOM，并带 layout/白名单 style；返回 shared string table | DOMSnapshot 是实验性 capture API，不是存储、语义清理或检索系统；全量 snapshot 也不应直接进入模型 |
| [CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/) | 支持 full/partial/query AXTree；AX node 可关联 backend DOM node；enable 后 AXNodeId 可跨调用保持一致 | 一致性有性能代价，且文档没有承诺跨 navigation 永久稳定；它不能单独承担长期 content ref 或 page revision |
| [W3C WebDriver](https://www.w3.org/TR/2026/WD-webdriver2-20260528/) | 标准定义 session 内 web element reference；若节点不属于 active document 或不再 connected，则为 stale 并返回 `stale element reference` | 我们的 `control_ref` 不是 WebDriver element reference，也不应声称协议兼容；借鉴的是“opaque handle + action-time stale validation + typed error”语义 |
| [HTTP Semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) | ETag 是 selected representation 的 opaque validator；`If-None-Match` 可进行条件 GET，匹配时返回无 content 的 304，以最小传输更新缓存 | origin ETag 通常不能代表 JS 渲染后的 DOM/AX 状态；Page Store revision 是客户端语义版本的类比，需要自行计算，不能直接复用所有 HTTP cache 语义 |
| [General Agentic Memory, 2025 preprint](https://arxiv.org/abs/2511.18423) | 存在同名 `page-store`：完整历史保存在数据库，在线 researcher 再按请求检索和整合 | 其 page 是 agent history session，不是网页；这是命名先例和架构趋同，不是标准，也不是 ReadPage 的直接实现依据 |

### MCP 能复用到什么程度

若未来希望把 Page Store 暴露为 MCP resource，可以采用类似 URI：

```text
page://{page_ref}/{revision}/digest
page://{page_ref}/{revision}/regions/{region_id}
page://{page_ref}/{revision}/chunks/{chunk_id}
page://{page_ref}/{revision}/targets/{target_id}/records
```

`inspect_page` 可以返回 `ResourceLink`；client 再决定是否读取某个 region/chunk。`resources/subscribe` 可以通知某个 logical page URI 已更新，再由 client 获取新 revision。MCP 明确允许 host 通过搜索、过滤、heuristics 或模型选择决定哪些资源进入 context，这与 task view 的责任分工一致。[MCP Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)

但需要保留三个差异：

1. MCP 的 `resources/list` pagination 是**资源列表分页**，不是规范化的资源内容 range/cursor；records/chunks 的分页仍是我们的 tool/resource URI 设计。
2. MCP subscription 只通知资源 URI 更新，不定义 DOM delta、revision hash 或 stale control 的语义。
3. 对 ReadPage 来说，query 与 action 是模型控制的操作，更适合保留为 tools；资源用于 addressable content。不要为了“全都资源化”而失去 query budget、权限检查和 typed errors。

### Revision 与 unchanged：HTTP 是语义模板，不是直接实现

RFC 9110 将 ETag 定义为同一 resource 不同 representation 的 opaque validator；`If-None-Match` 的主要用途之一是低开销更新已缓存信息，匹配时 GET/HEAD 返回 304 且没有 content。[RFC 9110 §8.8.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3) [RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2) [RFC 9110 §15.4.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.5)

Page Store 可以借用相同调用语义：

```ts
inspect_page({ tab_id, if_revision: "rev_abc" })
// 页面语义表示未变
=> { status: "unchanged", page_ref, revision: "rev_abc" }

// 页面已变，只返回 digest/delta 元数据
=> { status: "changed", page_ref, revision: "rev_def", changed_regions, omitted }
```

但浏览器 origin 的 ETag 只验证网络 selected representation；hydration、client-side filtering、滚动加载、用户态数据和 DOM mutation 可能在 ETag 不变时改变模型看到的页面。故 `revision` 应对 Page Store 的规范化表示计算，HTTP ETag 只能作为输入信号之一。

### Control ref 的 stale 语义：WebDriver 是最成熟的直接参照

WebDriver 的 element reference 是 session 内 opaque reference；取回节点时，如果 node 不存在或 stale，就返回 typed `stale element reference`。其 stale 定义包括 node document 不再是 active document，或 element 不再 connected。[W3C WebDriver element retrieval](https://www.w3.org/TR/2026/WD-webdriver2-20260528/#dfn-get-a-known-element) [W3C WebDriver stale definition](https://www.w3.org/TR/2026/WD-webdriver2-20260528/#dfn-stale)

ReadPage 应采用相同的失败原则：

- action 调用传 `{control_ref, revision}`；
- executor 先解析到 live frame/node，再校验 document、connected、role/name 或 locator fingerprint；
- 不一致时返回 `{code:"stale_control_ref", current_revision, refresh_scope}`；
- 只刷新所属 region/controls，不重新注入整页。

这比让模型根据旧 `pie_idx` 猜测，或无条件重读 interactive，更省 token，也更安全。需要明确的是：这是语义借鉴，不代表 `control_ref` 是 WebDriver wire protocol ID。

### 最终术语判断

`Page Store` 可以作为简洁的内部架构名，但设计文档第一次出现时应写成：

> **ReadPage Page Store（项目内部术语）**：版本化的本地页面资源与检索层。

它的组成技术都相当成熟：MCP 提供 addressable resources，Anthropic 给出 just-in-time context 的工程模式，RAG 给出外部非参数记忆与检索范式，CDP 提供浏览器捕获原料，WebDriver 给出 opaque element handle 和 stale error，HTTP 给出 representation validator 与 unchanged response。**成熟的是这些可组合的原语；把它们组合成 ReadPage 的 Page Store，仍然是我们的架构设计。**

## 协议格式补充：XML 应替换成什么

### 结论：不是换一种标记语言，而是分离三层表示

ReadPage/Atlas 不应把 TOON、CSV、CBOR 或另一种“更紧凑格式”直接当成 XML 的唯一继任者。更稳妥的组合是：

1. **规范数据与控制面：**以 compact JSON object 为 canonical result，并用 JSON Schema / MCP `outputSchema` 校验；这里承载版本、snapshot、revision、cursor、预算和 typed error。
2. **模型可见数据面：**默认使用 versioned JSON Lines frames；高基数、同构记录用“schema once + positional rows”，异构 metadata 仍用 compact JSON object。
3. **Atlas 内部 wire/cache：**可按性能需要使用 JSON Text Sequences、CBOR 或 MessagePack，但在内容进入模型前按任务裁剪并渲染为模型可理解的文本表示。
4. **信任边界：**可以保留最外层 `<untrusted_page_content>` wrapper 来标示页面数据不可信；替换的是 wrapper 内部逐项重复的 XML，而不是删除现有安全边界。JSON 文本需 neutralize wrapper closing tag，或由 host 以独立 content block 安全承载。

这项选择的核心不是“JSON 天生最省 token”，而是它同时满足严格解析、SDK 兼容、增量 framing、版本演进，并允许在最浪费 token 的同构数组上去掉重复 key。**格式只提供常数级优化；分页、检索和基数控制仍是主要杠杆。**上文的合成测量中，即使 1,000 controls 已改成 compact arrays，仍约为 10,946 tokens，而 top-40 约为 416 tokens。

### 已核验的格式事实

| 格式/承载 | 标准与严格解析 | token 特征 | 流式/分页 | ReadPage 判断 |
|---|---|---|---|---|
| Compact JSON | JSON 是 Internet Standard；UTF-8 网络交换、语法和数据模型明确。[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259.html) | object key 会逐条重复；minify 只能去空白 | 单个 JSON text 本身不定义多记录 framing 或分页 | canonical 控制面；异构/嵌套结构默认格式 |
| JSON Lines | 每行一个有效 JSON value、UTF-8、换行分隔；`.jsonl`，但 `application/jsonl` 尚未标准化。[JSON Lines](https://jsonlines.org/) | 可用数组帧消除重复 key；行仍对模型可读 | 天然逐记录处理，但协议必须自行定义 end、sequence、cursor | 默认模型数据面和内部简单流 |
| JSON Text Sequences | IETF 标准 `application/json-seq`，使用 RS + JSON text + LF；解析器可在坏帧后继续。[RFC 7464](https://www.rfc-editor.org/rfc/rfc7464.html) | 与所承载 JSON 相同，RS 不带来有意义的 token 优势 | byte-stream framing 比普通 JSONL 更严格；仍不定义业务分页 | 需要标准 media type 或流恢复时作为内部 framing |
| CSV | RFC 4180 是 Informational；可选 header、同列数、引号及双引号转义，但标准承认实现差异。[RFC 4180](https://www.rfc-editor.org/rfc/rfc4180.html) | 纯平表通常最小；含逗号、换行、引号的网页文本会增加 quoting | 可逐行，但 quoted multiline record 使分块复杂；无 schema/version/cursor | 只用于列稳定、值可控的纯表格导出 |
| TSV | IANA 注册了 `text/tab-separated-values`；注册说明字段内不允许 TAB，规范很薄。[IANA TSV registration](https://www.iana.org/assignments/media-types/text/tab-separated-values) | 比 CSV 少 quoting 的前提是先保证字段不含 TAB/记录分隔符 | 没有通用的嵌套、escaping、分页和演进协议 | 不适合任意页面文本；除非先做受限字段契约 |
| TOON | JSON data model 的 line-oriented 表示，有 ABNF、strict decoder 和 conformance fixtures；当前 v4.1 仍是 Working Draft，`text/toon` 为 provisional。[TOON specification](https://github.com/toon-format/spec) | 对高度同构数组能省重复字段；深层、非均匀数据可能比 compact JSON 更大 | 行式，但 ReadPage 仍需定义 snapshot、cursor、end 和版本 | 可协商的实验 codec，不作为 canonical/default |
| MCP `structuredContent` | JSON object；tool 可声明 JSON Schema `outputSchema`，结果必须符合 schema，client 应校验。[MCP Tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | “结构化”本身不免 token；若与等价 `TextContent` 一起注入会重复 | MCP tool result 不替 ReadPage 定义内容分页/record stream | 承载 canonical result 和校验，不同时向模型展示重复副本 |
| CBOR / MessagePack | 都是 binary serialization；CBOR 是 Internet Standard，MessagePack 规范定义 byte-array 编码。[RFC 8949](https://www.rfc-editor.org/rfc/rfc8949.html) [MessagePack specification](https://github.com/msgpack/msgpack/blob/master/spec.md) | 节省 wire bytes，不直接等于节省模型 tokens | 适合 IPC、cache、网络；模型前仍要解码 | 仅用于模型外 transport/storage |

上表的 token 与产品适用性判断是基于标准能力作出的工程判断；标准本身并未宣称某种格式普遍提升 LLM 效果。

### 本地同规模合成 benchmark：先规范形状，再讨论 codec

为避免用小片段推断整个 Atlas result，另做了一组同规模 synthetic benchmark：484 controls、16 forms、54 targets、83 field guesses。它比较的是**同一份合成数据的序列化形态**，不是生产页面分布，也没有测端到端任务成功率。

| 表示 | chars | `cl100k_base` proxy | `o200k_base` proxy | 相对 current XML 的 token 变化 |
|---|---:|---:|---:|---:|
| current XML | 70,631 | 26,579 | 24,961 | baseline |
| compact JSON objects | 59,742 | 22,398 | 20,908 | -16% |
| compact JSON schema + positional rows | 38,517 | 16,908 | 15,570 | -36% ～ -38% |
| schema-once TSV | 29,442 | 17,238 | 15,673 | -35% ～ -37% |
| Markdown tables | 29,615 | 18,464 | 16,899 | -30% ～ -32% |
| official TOON 4.1.1，raw sparse/nested object | 63,861 | 28,054 | 26,474 | **+5.5% ～ +6.1%** |
| official TOON 4.1.1，先规范为固定列 uniform object rows | 34,522 | 16,306 | 14,743 | -39% ～ -41% |

这组结果支持四个有限但可执行的判断：

1. 仅把 XML tags 换成 compact JSON objects，大约只得到 16% token 降幅；真正的跃迁来自**先把高基数数据规范成固定 schema rows**。
2. positional JSON 已取得约 36%～38% 降幅，并保持成熟 parser/schema 生态，应先作为 baseline 落地。
3. TOON 直接编码 raw sparse/nested object 反而更差；先规范成 uniform rows 后才优于 positional JSON，而且增量只约 4%～5%。这说明收益首先属于数据形状，其次才属于 codec。
4. TSV/Markdown 的 chars 明显更少，token 却不比 positional JSON 少；**更少字符不保证更少真实 tokens**。

这里的 `cl100k_base` / `o200k_base` 只是 tokenizer proxy，不等于任何 provider 的实际 billing，也不能代表模型理解质量。上文截图中使用的 `tokens = chars / 4` 只适合粗略量级估算；做协议决策应以目标模型 tokenizer、真实 API usage 和端到端效果为准。

### 推荐协议：ReadPage Frames v1

下面是建议的模型可见表示。它仍是 JSON Lines：每一行都是独立、合法的 JSON value。首帧声明 columns 一次，后续同构 control 用带类型 tag 的 positional row，末帧明确结束状态。

```jsonl
{"v":1,"t":"atlas","page":"pg_7","rev":"rev_9","seq":0,"schemas":{"c":["ref","role","name","frame","idx","state"]}}
["c","ctl_17","button","Save",0,431,"enabled"]
["c","ctl_18","textbox","Email",0,432,"required"]
{"v":1,"t":"end","seq":3,"next":"cur_2","omitted":{"controls":960},"truncated":false}
```

同一次调用中若还需正文或异构 metadata，可以加入不同的 discriminated frame，而不是把所有内容强压成一个二维表：

```jsonl
{"v":1,"t":"text","ref":"chunk_4","heading":"Pricing","text":"…","source":{"frame":0,"start":918,"end":1337}}
{"v":1,"t":"record-schema","id":"r1","fields":["name","price","availability"]}
["r1","Basic","$9","available"]
```

严格解析可以这样实现：

- 首帧和 object frames 分别用 JSON Schema 的 discriminated union 校验。
- positional row 用 `prefixItems` 校验 tag、列数与每列类型；schema ID 决定其解释方式。
- schema ID 一经发布不改变字段位置或语义；需要加列时发布 `c2`，而不是在 `c` 中插入字段。
- 未识别的可选 frame type 可以跳过；未识别的 required capability 返回 typed `unsupported_schema`，不能猜测解析。
- 所有用户页面文本只是 JSON string value，不再把一段 JSON 先 stringify、再作为 XML attribute 进行第二次 escaping。

这种 schema-once rows 保留了 CSV/TOON 最有价值的“字段名只声明一次”，同时仍处在成熟 JSON 解析与 JSON Schema 生态中。代价是 positional row 对人工阅读和字段演进更敏感，因此它只应用于高基数、同构集合；低基数 metadata 应继续用有名字的 object fields。

### 分页、流式和快照一致性必须属于应用协议

换成 JSONL 并不会自动获得可靠分页。ReadPage Frames 应明确以下约束：

- `next` 是 opaque cursor，绑定 `{page, rev, profile/query, scope, schemaVersion}`；任何一项变化都不能静默续读旧 cursor。
- 每页有单调 `seq`，并以 `end` frame 收口；`end` 必须给出 `next`、`omitted`、`truncated` 和截断原因。
- `end` 既解决普通 JSON Lines 没有协议级 end-of-sequence 的问题，也让 host 能区分“完整的一页”和“连接中断”。
- Atlas 内部若要求坏帧恢复，可用 RFC 7464 的 RS/LF framing；传给模型时仍可渲染为普通 newline-delimited JSON，避免不可见控制字符干扰调试。
- 对模型的真正分页仍是一页一次 tool result；不要因为内部 parser 能 streaming，就把无限记录持续推入同一个模型上下文。
- page mutation 后返回 typed `stale_cursor` 或 `revision_changed`，并给出最小 refresh scope，不能把新旧 snapshot 的 rows 混在一页里。

建议的 compact envelope 至少包含：

```ts
type ReadPagePage = {
  schemaVersion: 1;
  pageRef: string;
  snapshotId: string;
  revision: string;
  profile: "digest" | "content" | "interactive" | "records";
  frames: ReadPageFrame[];
  nextCursor?: string;
  omitted: Record<string, number>;
  truncated: boolean;
};
```

这里的 `frames` 是 canonical JSON/MCP view；host 可以把它渲染成上面的 JSON Lines，而不必在进程内把 JSONL 当成第二份 source of truth。

### MCP 与 provider tool result：使用 envelope，不要误把它当压缩

MCP `structuredContent` 的价值是让 host 取得可验证 JSON，并与 `outputSchema` 对齐。规范为了兼容旧客户端，建议同时给出序列化 JSON `TextContent`；这是 SHOULD 而不是 MUST。如果 host 把 `structuredContent` 和等价的 `TextContent` 都送入模型，token 反而接近翻倍。ReadPage 应只保留一个 canonical result，由 host 选择一种模型可见 renderer。[MCP Tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

Anthropic 的 `tool_result.content` 可以是 string 或 content blocks，并用 `tool_use_id` 关联调用；官方也建议工具响应只返回高信号字段和稳定语义 ID。[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) OpenAI Responses 的 `function_call_output` 同样以 `call_id` 关联，output 通常由应用编码为 string，官方示例使用 JSON；`strict: true` 约束模型生成的函数参数，不会自动验证应用返回的 tool output。[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

因此 provider envelope 解决隔离、关联和调用协议；它不会让 payload 免于 tokenization，也不会替 ReadPage 定义分页。模型可见 payload 的基数与编码仍必须由 ReadPage/host 控制。

### TOON：值得实验，但边界比宣传数字更重要

TOON 官方 benchmark 覆盖 244 个结构化数据检索问题、6 种格式、4 个模型，共 5,856 次调用；token 统一用 `o200k_base` 计算。其总体结果报告 TOON 相比 pretty JSON 少 42.6% tokens，准确率 72.2% 对 71.4%。但这不是“相比 compact JSON 普遍节省 42.6%”，也不是网页代理端到端评测。[TOON benchmark](https://github.com/toon-format/toon#benchmarks)

官方数据本身给出了边界：

- mixed-structure 汇总中，TOON 为 264,734 tokens，compact JSON 为 260,451，TOON 约多 1.6%；
- nested ecommerce 中，compact JSON 为 6,875，TOON 为 7,344；
- semi-uniform events 中，compact JSON 为 4,793，TOON 为 5,814；
- uniform employee 数据中，CSV 2,336、TOON 2,537、compact JSON 3,919；
- `gpt-5.4-nano` 的汇总准确率为 TOON 57.0%、JSON 57.4%、XML 59.4%，不能据此宣称 TOON 对所有模型理解都更好。

此外，该 benchmark 测的是 retrieval、aggregation、filtering 和 structure recognition，没有测试网页 DOM、长正文引用、工具生成 TOON、分页恢复或多轮 agent task success；绝对 token 数也依赖目标模型 tokenizer。仓库自己的 “When Not to Use” 同样指出：深层/非均匀结构常由 compact JSON 获胜，纯表格 CSV 更小，半规则数据收益缩小，延迟需要在实际模型上测试。[TOON repository](https://github.com/toon-format/toon)

所以 TOON 的合理位置是：

- 只对 tabular eligibility 很高的 records/control block 开启；
- 通过 capability/version 协商作为 renderer，不作为 Page Store 存储真相；
- 按 Atlas 真实页面分布、目标模型 tokenizer 和端到端任务成功率 A/B；
- 发现 deep/nonuniform shape 时自动回退 compact JSON；
- 在 TOON spec 仍为 Working Draft、media type 仍 provisional 时，不作为跨 provider 的公开稳定协议。

### 为什么 CBOR/MessagePack 不直接降低模型 token

CBOR 和 MessagePack 优化的是序列化后的 bytes。CBOR 的 diagnostic notation 明确不是实际 interchange，也不是供应用解析的 wire syntax；MessagePack 的序列化结果是 byte array。[CBOR diagnostic notation](https://www.rfc-editor.org/rfc/rfc8949.html#section-8) [MessagePack specification](https://github.com/msgpack/msgpack/blob/master/spec.md)

现有 tool-result 路径最终仍需给模型 text/content blocks；MCP 的 binary resource 也是 base64 string。若把 CBOR/MessagePack 直接放入 prompt，只能：

1. base64/hex 编码成不透明文本；Base64 每 24 input bits 产生 4 个输出字符，即在 tokenization 之前已有约 33% 字符膨胀和 padding。[RFC 4648](https://www.rfc-editor.org/rfc/rfc4648.html)
2. 或先解码回 JSON/TOON/text，再由这些文本接受 tokenization。

因此二进制可以减少 Atlas 与 Page Store 之间的网络、缓存或 IPC bytes，却不能直接减少模型 input tokens。若 code/tool layer 在模型外解码、过滤 10,000 rows，只返回相关 40 rows，token 节省来自**模型外过滤和基数下降**，不是来自 CBOR 本身。

### 推荐的迁移顺序

1. **立即停止双重编码：**canonical data 直接保持 JSON object；不再把 record JSON stringify 后塞进内部 XML attribute，也不同时注入 structured/text 两份等价结果。最外层 untrusted wrapper 可以保留。
2. **先上 compact JSON schema-once rows：**只覆盖 controls、records 等高重复集合；正文和异构 metadata 保持有名字的 object fields。
3. **补齐 result contract：**加入 `schemaVersion`、`snapshotId`、`revision`、`nextCursor`、`omitted`、`truncated`、typed stale errors 和明确 end receipt。
4. **按页调用分页：**Page Store 保留全量资源，模型默认只取得 task-bounded page；JSONL/RFC 7464 仅作为 framing，不作为扩大返回量的理由。
5. **做 shape-aware codec 实验：**只在高度规则数据上比较 compact object JSON、schema-once JSON rows、TOON 与 CSV，按真实 tokenizer、首 token/总延迟、parse failure、引用正确率和端到端 task success 决策。
6. **最后才优化内部 wire：**若 profiling 证明 Atlas↔Page Store 的 bytes/CPU 是瓶颈，再引入 CBOR/MessagePack；它与模型 token 优化分别评估。

最终协议选择可以压缩成一句话：**保留最外层 untrusted wrapper；MCP `structuredContent` + JSON Schema 做可验证控制面，compact JSON schema-once rows / JSON Lines 做默认模型数据面，cursor + snapshot/revision 保证分页一致性；TOON 仅做可协商的 shape-specific 优化，CBOR/MessagePack 仅留在模型之外。**
