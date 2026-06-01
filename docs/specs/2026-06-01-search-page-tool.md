# 页面内搜索工具 `search_page` — 设计

> 状态:设计待 review,未排期。
> 日期:2026-06-01
> 背景:`read_page` 把整页 HTML 一次性塞给 LLM,但有 50KB 预算截断;PDF 有 `read_pdf` + `search_pdf`,页面却只有 `read_page`,缺一个"先搜后定位"的检索原语。本 spec 设计页面侧的对称工具 `search_page`。
> 相关历史:`2026-05-25-unified-page-snapshot-design.md`(`read_page` 的 `data-pie-idx` stamp 逻辑来源)、`2026-05-28-pdf-agent-design.md`(`search_pdf` 范式)、`2026-05-14-issue-38-page-content-reference-design.md`(`untrusted_page_quote` / `untrusted_page_element` 的归属——**与本工具无关,不复用**)。

## 一句话

给页面加一个 `search_page(tabId, query, max_results?, mode?, regex?)` 工具:在 **live DOM 全量文本**上做关键词 / 正则匹配(**绕开 `read_page` 的 50KB 截断**),每个命中回 **最近可交互祖先的 `data-pie-idx` 锚点 + 上下文片段**,让 LLM 在大页面里"先搜后点 / 先搜后读",而不用整页 `read_page` 再肉眼翻找。

## 为什么不做语义搜索(决策记录)

用户问过能否做语义搜索。结论:**当前不做,语义交给 LLM 自己承担**。三条路的评估:

| 路 | 做法 | 否决理由 |
|---|---|---|
| A. embedding API(BYOK key) | 切块→调 embedding→算相似度 | Anthropic 无 embedding API;provider 参差;`model-router` 全是 chat completions,要新加通路;整页文本外发(隐私/成本) |
| B. 本地 embedding(WASM) | 复用 offscreen WASM 先例跑 embedding | 模型 30–120MB(LiteParse 才 4MB);`onnxruntime-web` 在 MV3 SW 的 CSP 可行性需单独验证;live DOM 无缓存,每次现切块现编码;独立子系统,几周工程 |
| **C. LLM 自驱(本工具采用)** | 关键词检索原语 + LLM 把抽象意图扩成一组同义词 | 零依赖、零成本、对所有 provider 一致;契合本项目"LLM 控制"哲学(已砍掉 risk classifier / MAX_STEPS / give-up) |

路 C 的关键支撑:`query` 接受**关键词数组**,LLM 意图抽象时(如"取消订阅相关")自己扩成 `["cancel","unsubscribe","subscription","billing","manage plan"]` 一次搜完,没中再换词。本地 embedding(路 B)作为**未来可选 Phase**保留,等真实数据显示 LLM 多关键词搞不定的抽象查询确实高频再上(见文末)。

## Tool 契约

```
search_page(tabId, query, max_results?, mode?, regex?)
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tabId` | integer | ✓ | 目标 tab,对齐 `read_page` |
| `query` | string[] \| string | ✓ | 一个或多个 term,**OR 命中**。`regex=false` 时为字面子串(大小写不敏感);`regex=true` 时每个 term 为一个正则 pattern |
| `max_results` | integer | — | 默认 10,上限 50,对齐 `search_pdf` |
| `mode` | "all" \| "interactive" \| "text" | — | 默认 `all`。`interactive`=只搜可交互元素文本;`text`=只搜正文文本节点 |
| `regex` | boolean | — | 默认 `false`(字面子串)。`true` 时 term 按正则编译,flags 固定 `gi`(global+大小写不敏感) |

单字符串 `query` 归一化为单元素数组。

返回(XML,对称 `search_pdf`):

```xml
<search_page total_matches="N" mode="all" truncated="true|false" timed_out="false">
  <untrusted_page_match frame_id="0" pie_idx="42" tag="button" matched="refund">…命中点前后约 80 字上下文…</untrusted_page_match>
  <untrusted_page_match frame_id="0" pie_idx="" tag="p" matched="price">…纯文本命中,无可交互锚点(pie_idx 空)…</untrusted_page_match>
</search_page>
```

无命中:`<search_page total_matches="0" mode="all">no matches</search_page>`

每条命中字段:
- `frame_id` — 命中所在 frame(跨 frame 聚合,frame_id 映射沿用 `read_page` 的 `data-pie-iframe-position`→`data-frame-id` 重写机制)
- `pie_idx` — 命中文本所在节点 / **最近可交互祖先**的 `data-pie-idx`;空 = 纯文本命中、不可点。这一格同时服务"找控件"(非空→可直接 `click`/`type`)与"找文本"(空→定位内容)两个痛点
- `tag` — 命中节点 tag(帮 LLM 判断命中类型)
- `matched` — `regex=false` 时是命中的 query term;`regex=true` 时是**实际命中的文本**(`match[0]`,截断到合理长度),让 LLM 知道正则到底匹配到了什么

## 抓取 + `data-pie-idx` 锚定(核心技术点)

self-contained 注入函数(仿 `pageSnapshotInjected`),`chrome.scripting.executeScript({ allFrames: true })` 跨 frame fanout。

**关键不变量 — idx 一致性**:`search_page` 返回的 `pie_idx` 必须与 `read_page` 盖出的**完全一致**,否则 LLM 拿 idx 去 `click` 会点错元素。

落地方式(plan 勘查后修正):因注入函数必须 **self-contained**(executeScript 只序列化函数体,无法 import 外部函数——`page-snapshot.ts` 注释明确这点),运行时"共享函数"不可行。改为 **`search_page` 注入函数源码内联复制 `read_page` 的 stamp 逻辑**(`walkDeep` + `isVisible` + `INTERACTIVE_SELECTOR` + 清除并按 `walkDeep(document.body)` 顺序从 0 递增盖 idx),与 `page-snapshot.ts` Step C 逐字一致。这正是本仓库既定模式(`page-snapshot.ts` 自身就是从 `dom-walk.ts`/`html-strip.ts` 复制而来,注释称 intentional)。一致性靠一条**跨层单测**护栏(同页两个注入函数盖出的 idx 必须相同)。`read_page` / `page-snapshot.ts` 的 stamp 逻辑**不改动**(零回归)。

> `data-pie-idx` 是**每 frame 独立**从 0 编号的(每个 frame 各跑一次注入),所以定位永远是 `frame_id` + `pie_idx` 配对 —— `search_page` 每条命中都带 `frame_id`。

**全量遍历,不截断**:遍历**所有**文本节点找命中(这正是绕开 `read_page` 50KB 痛点的核心)。只有**返回的命中条数 / 字节**受 `max_results` + 一个返回字节预算约束;命中超限时按 DOM 顺序截断,`truncated="true"`,`total_matches` 仍报全量。

`mode` 过滤:
- `all` — 遍历全部文本节点
- `interactive` — 只看挂在 `INTERACTIVE_SELECTOR` 命中元素(或其后代)里的文本
- `text` — 只看不在可交互元素内的正文文本节点

## 搜索算法

- 遍历 `walkDeep(document.body)`(含 open shadow DOM)每个元素,取其**直接 Text 子节点**拼接的文本,按 `mode` 过滤后做匹配——命中归属到"最贴近文本的元素",`pie_idx` 锚点最精确
- `regex=false`:`text.toLowerCase().indexOf(term.toLowerCase())` 子串匹配(对齐 `search_pdf` 风格)
- `regex=true`:每个 term `new RegExp(term, "gi")` 编译后匹配
- 多 term **OR**:任一 term 命中即算;`matched` = 命中的 term(`regex=false`)或实际命中文本 `match[0]`(`regex=true`,截断 ~80 字)
- 粒度:**每元素至多一条**(只取该元素文本里的首个命中,不在单节点内 while 循环全文),按 `walkDeep` DOM 顺序排列
- snippet:以命中点为中心、前后约 80 字上下文,首尾加 `…`(复用 `search_pdf` 的 `buildSnippet` 思路)
- `total_matches` 统计全部命中元素数;每 frame 注入内按 `max_results` 截,handler 跨 frame 合并后再全局截到 `max_results`,超出标 `truncated="true"`

**不做** AND 语义(交给 LLM 跨多次搜索 / 读片段判断)。

**已知局限(MVP,注明而非隐藏)**:
- 只搜**元素直接文本**——跨 inline 标签的连续短语(如被 `<a>` 切开的 "Click me")可能漏命中,LLM 应改用更短关键词(契合 LLM 自驱)
- 不搜 `input` 的 `value`/`placeholder`、元素的 `aria-label`/`title` 等属性文本(未来可加)

### 正则的健壮性守卫(必须)

正则跑在**注入到页面的脚本**里、用户页面上下文——一个坏 pattern 能冻死那个 tab。防护:

1. **ReDoS 时间预算守卫**:注入函数在**元素遍历循环**里用 `performance.now()` 累计耗时,超过预算(~1.5s)立即中止,返回已找到的命中 + `timed_out="true"`。JS 无原生 regex timeout,靠循环打点。
2. **单节点扫描长度上限**:对单个元素文本超过上限(~50000 字)的部分只扫前缀(snippet 仍取完整文本),压住"单次 `exec` 在超长文本 + 灾难正则下卡死、来不及触发时间守卫"的最坏情况。
3. **无效正则**:`new RegExp` 抛异常 → 注入函数返回 `invalidRegex` 字段 → handler 转成 `invalid_regex: <message>` 错误(`success:false`),**不**让注入脚本崩。
4. **空匹配死循环**:本实现**每节点只取首个匹配、不 while 循环全文**,从根上消除空匹配(如 `a*`)死循环风险——无需手动推进 `lastIndex`。

`regex=false`(默认)不涉及正则风险,但时间守卫与扫描上限对超大页面的字面搜索同样兜底。

## 边界 & 安全

- **PDF tab**:返回 `pdf_tab:` 错误引导改用 `search_pdf`(对齐 `read_page` 在 PDF tab 的行为)
- **restricted scheme / discarded tab**:沿用 `read_page` 的前置检查与错误
- **跨 frame**:`executeScript allFrames` 各 frame 独立搜,handler 聚合;不可达 frame(cross-origin 失败 / about:blank)跳过,不阻断其他 frame 结果
- **untrusted 包装**:命中片段是页面内容 → 全部包 **新 wrapper `untrusted_page_match`**(与 `untrusted_pdf_match` 对称),片段过 `escapeUntrustedWrappers`、属性过 `escapeWrapperAttribute`。**不复用** `untrusted_page_quote`/`untrusted_page_element`(那是 sidepanel 用户手动引用功能的,语义不同)
- **wrapper 双清单同步**:新增 `untrusted_page_match` 需同步登记到两处——`untrusted-wrappers.ts`(`UNTRUSTED_WRAPPER_TAGS`,`escapeUntrustedWrappers` 用,真正保护 search_page 输出)与 `dom-actions/page-snapshot.ts`(`WRAPPER_TAGS_LIST`,read_page 注入侧中和页面伪造的同名标签)。**`html-strip.ts` 不涉及**:其 `stripToWhitelist` 全 src 仅被自身测试引用、且早已与 PDF/local-file wrapper 脱节(连那几个都没加),不在 search_page 数据流上
- **tool 分类**:`search_page` 是 **read-class**(只读不改 DOM),登记进 `tool-names.ts` 的 `TOOL_CLASSES`

## 测试策略

注入函数纯逻辑单测(happy-dom):
- 多 term OR 命中 / 大小写不敏感 / snippet 边界(首尾 `…`)
- 按命中节点去重聚合
- `pie_idx` 锚定到最近可交互祖先;纯文本命中 `pie_idx` 为空
- `mode` 三态过滤正确
- 正则:`gi` 大小写不敏感 / 空匹配正则(`a*`)不死循环 / 无效正则报 `invalid_regex` / ReDoS pattern 触发 `timed_out`

handler 层:
- 无命中返回 `no matches`
- 命中超 `max_results` → `truncated="true"` 且 `total_matches` 报全量
- PDF tab 返回 `pdf_tab:` 错误
- 跨 frame 聚合 + 不可达 frame 跳过

安全:
- 命中片段含 `</untrusted_page_match>` 或同类注入变体 → 被 `escapeUntrustedWrappers` 转义

**跨层回归(关键)**:同一页面上 `search_page` 与 `read_page` 盖出的 `data-pie-idx` 一致(共享 stamp 的核心验证)。

## 涉及文件(预估,plan 阶段细化)

| 文件 | 改动 |
|---|---|
| `src/lib/dom-actions/search-page.ts`(新) | self-contained 注入函数 `searchPageInjected` + 类型(stamp 逻辑内联复制自 page-snapshot.ts) |
| `src/lib/agent/tools/search-page.ts`(新) | `searchPageTool` 定义 + handler |
| `src/lib/dom-actions/page-snapshot.ts` | 仅 `WRAPPER_TAGS_LIST` 加 `untrusted_page_match`(stamp 逻辑**不改**) |
| `src/lib/agent/untrusted-wrappers.ts` | `UNTRUSTED_WRAPPER_TAGS` 加 `untrusted_page_match` |
| `src/lib/agent/tools.ts` | import + 注册 `searchPageTool` 进 `BUILT_IN_TOOLS` |
| `src/lib/agent/tool-names.ts` | `PAGE_SNAPSHOT_TOOL_NAMES` 加 `search_page`;`TOOL_CLASSES["search_page"]="read"` |
| `src/lib/dom-actions/search-page.test.ts`(新) | 注入函数单测 + 跨层 idx 一致性回归 |
| `src/lib/agent/tools/search-page.test.ts`(新) | handler 单测 |
| `src/lib/agent/untrusted-wrappers.test.ts` | 加 `untrusted_page_match` 转义断言 |

`read-page.ts` / `html-strip.ts` **不改动**。

## 未来 Phase(不在本次范围)

**本地 embedding 语义重排(方案 2)**:在 `search_page` 的关键词召回之上叠一个 offscreen 本地 embedding(复用 PDF 的 WASM/offscreen 模式),做语义重排或纯语义兜底,模型按需下载。触发条件:方案 1 上线后,真实使用显示"LLM 多关键词也搞不定的抽象意图查询"确实高频。届时单独 spec。
