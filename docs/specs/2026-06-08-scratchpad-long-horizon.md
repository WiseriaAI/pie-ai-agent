# 长程任务稳定性：草稿本（Scratchpad）外部记忆机制

- 日期：2026-06-08
- 状态：设计已评审通过，待写实施计划
- 范围：`src/lib/agent/`（loop / tools / prompt / window 协同）、`src/lib/scratchpad/`（新增）、`src/offscreen/`（SQL 桥接）、`src/lib/files/`（导出复用）

## 1. 背景与问题

数据抽取 / 自动化爬虫场景下，agent 需要在长程任务中累积大量数据。当前这些数据**只活在 LLM 的对话上下文里**，而上下文有三道裁剪机制会动它，导致"几轮迭代后 agent 自己就忘了"：

1. **Sliding window**（`window.ts`）——只保留最近 12 对 react，更早的步骤从喂给 LLM 的副本里裁掉。
2. **Compaction**（`compact-react-window.ts`）——超 token 阈值时把最旧的若干步用 LLM 摘要成一对合成消息；摘要有损，"第 37 条记录价格 ¥199"这种细节几乎必然丢失。
3. **Elide stale observations**（`elide-stale-observations.ts`）——历史页面 DOM 被短标记替换。

现有的 `output_file` 是**终点一次性交付**（产出 + 下载卡），不是过程中的增量暂存；LLM 也没有被引导在抓取过程中持续往外写。

**根因**：数据缓存在"上下文"这个易失介质里。**核心洞察**：把数据从上下文搬到 IndexedDB 这个持久介质，上下文里只留一个有界的、永不被裁的「概览指针」。绞肉机绞的是"过程对话"，数据和状态已经不在对话里了。

## 2. 设计目标与非目标

**目标**
- 长程抽取任务中，数据、进度状态稳定可靠地缓存在上下文之外，不随上下文裁剪丢失。
- 支持就地数据清洗（去重 / 过滤 / 聚合 / 转换），清洗在数据层发生、结果不回灌 LLM 上下文。
- 复用现有成熟基建（IndexedDB 单库 `pie`、offscreen + WASM、`output_file` 下载卡），增量落地、不推翻既有设计。

**非目标**
- 不做系统自动抽取（不在每轮观测里猜测并自动沉淀数据）——由 LLM 主动写，与"终止只由 LLM 控制、不做运行时干预"的既有哲学一致。
- 不新增独立的草稿本 UI 面板（交付复用 `output_file` 下载卡）。
- 不让 LLM 跑任意 JS 清洗（MV3 CSP 禁 `eval`/`new Function`；用 SQL 沙箱替代）。

## 3. 架构总览

```
持久层（事实源，权威）              计算层（瞬态，可丢弃）
┌──────────────────────────┐      ┌──────────────────────────┐
│ IndexedDB pie/            │      │ offscreen document        │
│   scratchpads store       │ ──→  │   sql.js (SQLite WASM)    │
│   key = ${sessionId}      │      │   内存临时表              │
│   - collections           │ ←──  │   跑 SQL，出结果集        │
│   - notes                 │      │   用完即弃 / SW idle 回收 │
└──────────────────────────┘      └──────────────────────────┘
     save_records / read_records          query_scratchpad
     update_notes / clear_scratchpad      (新增的唯一桥接)
     = 持久层 CRUD
```

**分层原则**：IndexedDB 是唯一事实源；SQLite 只是**瞬态清洗协处理器**，无任何持久状态。SQLite 对草稿本的关系，等同于 offscreen 里 LiteParse 对 PDF 的关系——offscreen 里的东西都是可丢弃的派生物，SW idle → offscreen 回收 → 下次重新加载。这套生命周期哲学已在 PDF 能力上线验证。

## 4. 数据模型

IndexedDB 单库 `pie` 新增 `scratchpads` object store，`keyPath: "id"`，key = `${sessionId}`：

```ts
interface Scratchpad {
  id: string;                              // = sessionId
  collections: Record<string, Collection>; // 结构化记录区，可有多张命名表
  notes: string;                            // 自由进度笔记区（整块覆写）
  updatedAt: number;
}

interface Collection {
  name: string;            // 如 "products"
  fields?: string[];       // 可选 schema 提示（首次 save 时声明）
  dedupeKey?: string;      // 可选去重字段，如 "url"
  records: Array<Record<string, unknown>>; // append-only
}
```

设计决策：
- **去重内置**：`dedupeKey` 命中重复的记录静默跳过，写入返回里明确报跳过数。比让 LLM 自己记"哪些爬过了"可靠。
- **多张命名表**：一个任务可能同时爬两类东西（商品 + 评论）。默认一张表，允许 LLM 开多张。
- **notes 与 records 分离**：records 是 append-only 数据；notes 是可整体覆写的进度状态。读写语义不同，分开更清晰。

跨 store 原子写沿用 `txMulti`（D9 原子写不变量）。容量上限仿 `output-store`，本期定 **50MB/session**，超限明确报错而非崩溃。Backlog：后续按需放大或做成用户可调（IndexedDB 本身已无 10MB 限制，上限纯属保护性配额）。

## 5. Tool 接口

新增 5 个 tool，均在 `tool-names.ts` 登记 read/write class（否则 build 期 throw）。

| Tool | Class | 入参 | 行为 |
|---|---|---|---|
| `save_records` | write | `collection`, `records: object[]`, `dedupeKey?`, `fields?` | append 到指定表，首次可声明 `fields`/`dedupeKey`（之后沿用）。返回 `{added, skipped, total}`。dedupe 让它幂等——重试同批不重复。 |
| `update_notes` | write | `notes: string` | 整块覆写进度笔记（LLM 自维护 markdown）。 |
| `read_records` | read | `collection`, `offset?`, `limit?`, `query?` | 分页读回明细（默认不全量，防 token 爆）。`query` 做简单子串过滤。返回记录 + 分页游标。 |
| `query_scratchpad` | read | `sql`, `from`, `into?` | SQL 清洗（见 §6）。无 `into` 返回结果摘要；有 `into` 写回新 collection。 |
| `clear_scratchpad` | write | `collection?` | 重置整本或某张表（续爬新目标时用）。 |

设计决策：
- **不需要 `read_notes`**：notes 全文已常驻在每轮概览里（§7），无需再读。
- **`save_records` 合并 append + dedupe 语义**为一个幂等 tool，不拆成 append/set。
- **不新增导出 tool**：导出由 LLM 收尾时调现成的 `output_file`（把某张表序列化成 CSV/JSON）。在 system prompt 里教这个收尾动作。

## 6. 清洗子系统（SQL via offscreen WASM）

`query_scratchpad` 数据流：
1. 从 **IndexedDB** 读出 `from` collection 的 records（事实源）。
2. 桥接到 offscreen，导入一张内存 SQLite 临时表（表名 = `from`）。
3. 跑 LLM 给的 `sql`（`SELECT/UPDATE/DELETE` 等）。
4. 结果去向：
   - `into` 省略 → 结果集摘要回 LLM（行数 + 前 N 行预览，预览值用 untrusted wrapper 包）。
   - `into: "products_clean"` → 结果整表写回 IndexedDB 成新 collection（清洗产物也是事实源，可再 `output_file` 导出）；返回 `{rows, into}`，不回灌明细。
5. SQLite 内存表丢弃（或按 `sessionId+from` 在 offscreen 短缓存，SW idle 回收）。

实现要点：
- **复用同一个 offscreen document**：MV3 一个扩展同时只能有一个 offscreen document，因此 SQL 引擎不能新建独立 offscreen 文档，必须挂进现有的 PDF offscreen（`pdf-parser.html`），按 message 的 `type` 分发到 SQL handler。`offscreen-manager.ts` 的 lifecycle / reason 需相应扩展（PDF 用的 reason 与 SQL 计算可共存于同一文档）。
- **SQL 引擎模块**仿 `src/offscreen/pdf-parser.ts`：懒加载 sql.js WASM；SW↔offscreen 经 `offscreen-manager.ts` 的 request/response 桥（`chrome.runtime.sendMessage({target:"offscreen"})`）。
- **嵌套字段**导入时存 SQLite json 列（用 SQLite json 函数可查）。
- **WASM 资源**：build 期从 `node_modules` copy sql.js 的 `.wasm` 到 `public/`、emit 到 `dist/`（仿 LiteParse），gitignore。需 `wasm-unsafe-eval` CSP（PDF 已开）。
- **导入开销**：几百~几千条毫秒级无感；遇到几万条超大表时缓存 SQLite 实例避免重复导入（纯优化，不影响架构）。

**安全**：SQL 在 WASM 沙箱内执行，只能动导入的草稿本数据，碰不到页面/网络/扩展状态。即便页面注入诱导 LLM 跑恶意 SQL，最坏后果也只是弄乱自己的草稿本——可接受。无需额外 SQL 解析防护。

## 7. 与上下文管理的协同（机制命门）

光有持久草稿本不够，关键是让三道裁剪机制动不到要害。

**① 概览注入位置（永不被裁的关键）**

每轮 `buildObservationMessage()` 拼观测时，额外附一个 `<scratchpad_overview>` 块，跟着**当前轮的观测**走。观测并入的是最新 user turn，而最新 user turn 是 trailing message——sliding window、compaction、token budget **三道机制都不动 trailing**。旧轮的旧概览随旧观测被 elide/裁掉（无所谓，只需最新那份）。

概览内容（**有界**，不随记录总数线性增长）：
```
<scratchpad_overview>
collections:
  - products: 142 条 (dedupeKey=url), 最近3条预览: <untrusted_scratchpad_preview>...</untrusted_scratchpad_preview>
  - reviews: 38 条
notes:
  已爬完分类 A、B（第1-5页）；待办：分类 C、D；当前在 C 第2页
</scratchpad_overview>
```

**② 为什么 compaction 伤不到数据**

`save_records` 执行的瞬间，记录已落进 IndexedDB。哪怕这一步的 react 消息事后被 compaction 摘成一句话，**数据一条不丢**（在 IndexedDB），**计数和进度也不丢**（在每轮刷新的概览里）。绞肉机绞的是过程对话，数据和状态已不在对话里。

**③ 安全边界（untrusted 不变量）**

- 概览的**结构性元数据**（表名、计数、dedupeKey）系统聚合，trusted。
- 概览的**记录值预览**来自页面抓取，untrusted，用新 wrapper `<untrusted_scratchpad_preview>` 包裹。
- `notes` 是 LLM 自己写的输出回喂，trusted。
- 新 wrapper 须在 `untrusted-wrappers.ts` 的 `UNTRUSTED_WRAPPER_TAGS` 和 `page-snapshot.ts` 的 `WRAPPER_TAGS_LIST` **双表登记**（双表不变量）。

**④ 与 SOFT_STEP_BUDGET 配合**

loop 无界（过软预算只升级软提示）。在软提示里加引导："如果在累积数据，确保已通过 `save_records` 落盘，不要依赖记忆"——把草稿本变成长程任务默认习惯。

## 8. 生命周期

- 草稿本 per-session，随 session 删除而清。
- task `done` 后**保留**（用户可能续爬 / 重新导出）。
- 新 task 不自动清；`clear_scratchpad` 由 LLM 主动重置（续爬新目标时）。
- at-rest 存 IndexedDB（持久、跨 SW restart 存活）。

## 9. 错误处理

所有 tool 失败返回结构化错误文本让 LLM 自纠，不静默吞：
- `records` 非数组 / 空入参 → 明确错误提示。
- 读 / 查不存在的 collection → 返回空 + 列出可用 collection 名（帮 LLM 自纠）。
- SQL 语法错 → 回传 SQLite 错误信息。
- 容量超限 → 明确报错而非崩溃。

## 10. 交付路径

复用现有 `output_file` 下载卡：done 收尾时 LLM 把目标 collection 序列化成 CSV/JSON 调 `output_file`，走现成的侧栏下载卡 + 另存为链路。草稿本定位为"过程暂存"，`output_file` 定位为"最终交付"，职责清晰。

## 11. Build 期不变量与测试

**Build 期不变量**
- 5 个新 tool 在 `tool-names.ts` 登记 read/write class。
- 新 untrusted wrapper `untrusted_scratchpad_preview` 双表登记。

**测试**
- 草稿本 CRUD + dedupe 正确性（vitest）。
- 概览注入有界性 + 搭车 trailing observation 永不被裁（在 window / compaction 测试里加 case）。
- offscreen SQL 桥接（mock offscreen，仿现有 PDF 测试）；`into` 写回链路。
- untrusted wrapper 转义。
- 导出到 `output_file` 链路。

## 12. 涉及文件（预估）

```
src/lib/scratchpad/
├── types.ts                    # Scratchpad / Collection 定义
├── store.ts                    # IndexedDB CRUD（save/read/update_notes/clear），dedupe
├── overview.ts                 # 概览块构建（有界 + untrusted 包裹）
└── sql-bridge.ts               # SW 侧 query_scratchpad → offscreen 桥接

src/offscreen/
├── sql-engine.ts               # sql.js 加载 + 导入/查询/导出（仿 pdf-parser.ts）
└── pdf-parser.ts / .html        # 复用同一 offscreen 文档，按 message type 分发 SQL handler（MV3 单 offscreen 约束）

src/lib/agent/
├── tools/scratchpad.ts         # 5 个 tool 实现
├── tool-names.ts               # 新 tool read/write class 登记
├── loop.ts                     # buildObservationMessage 注入概览
├── prompt.ts                   # system prompt 草稿本引导节
└── untrusted-wrappers.ts       # 新 wrapper 登记

src/lib/idb/db.ts               # scratchpads store 声明
src/lib/agent/page-snapshot.ts  # WRAPPER_TAGS_LIST 登记新 wrapper

public/ + build 配置             # sql.js WASM copy（仿 LiteParse）
```
