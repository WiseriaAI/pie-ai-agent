# 合并 page-atlas 读工具 → read_records（issue #162，Option B）

**日期**: 2026-06-24
**Issue**: WiseriaAI/pie-ai-agent#162 — P2 · feature
**决策**: 用户已在 issue 评论锁定 **Option B**。本 spec 直接落地，不再比选方案。

## 目标

把 page-atlas 的 3 个高度重叠的读工具合并成 1 个 type-dispatched 工具，消除「collection vs table 猜错类型 → `unsupported_target_type` 被拒」的脆弱路径：

```
read_collection + read_table + extract_records  →  read_records({atlas_id, target_id, range?, fields?})
```

保留 `find_target`、`read_target`。**5 → 3 工具**：`find_target` / `read_records` / `read_target`。

## 为什么这是真痛点（非纯去重）

`collection` vs `table` 的边界是模糊的（带表头的列表算 table 还是 collection？），且分类由 atlas builder / LLM 做、不是调用方。当前 `read_collection` 对 atlas 标成 `table` 的目标调用会被 `resolveTarget` 以 `unsupported_target_type` 拒绝——制造了「猜对类型才能用」的失败路径。单一 type-dispatched 读工具按目标**实际** `type` 渲染，直接消除该路径。

`extract_records` 已经是 type-agnostic（`allowedTypes = [collection, table, detail_region]`），证明单工具读多类型可行；把它的字段投影降为 `read_records` 的一个可选 `fields` 参数即可。

## 现状（勘察结论）

3 个待合并工具的 handler 除以下差异外逻辑同构（同一套 `resolveTarget` / `selectedRecords` / `wrapUntrustedPageContent`）：

| 维度 | read_collection | read_table | extract_records |
|---|---|---|---|
| `allowedTypes` | `["collection"]` | `["table"]` | `["collection","table","detail_region"]` |
| 输出 | `renderRecords("collection_records", …)` XML | `renderRecords("table_records", …)` XML | `renderExtractedRecords(records, keys)` JSON |
| 投影 | 无（全字段） | 无（全字段） | 按 `schema` 对象的 key 投影 |

公共 helper（**全部复用、不改**）：`resolveTarget(store, getPageState, ctx, atlasId, targetId, allowedTypes)`、`selectedRecords(records, range)`、`renderRecords(tag, atlasId, target, records)`、`renderExtractedRecords(records, keys: string[])`、`wrapUntrustedPageContent(tool, atlasId, targetId, body)`、`isNonEmptyString(v): v is string`。

## 设计

### read_records 工具

参数 `{ atlas_id, target_id, range?, fields? }`：
- `fields?: string[]` —— **可选**字段名数组。给且非空 → 投影（等价旧 `extract_records`，JSON）；省略/空 → 全记录（等价旧 `read_collection`/`read_table`，XML）。把旧 `extract_records` 的 `schema` 对象（靠 `schemaKeys()` 提 key）简化为直接的字符串数组。
- `allowedTypes = ["collection", "table", "detail_region"]`（type-agnostic，去掉 collection/table 猜测）。
- handler 逻辑：
  1. 校验 `atlas_id` + `target_id`（缺则 `fail(... requires atlas_id and target_id)`）。
  2. `resolveTarget(...)` with 上述 allowedTypes。
  3. `selectedRecords(records, range)` 分页。
  4. `fields` 非空 → `renderExtractedRecords(records, fields)`；否则 → `renderRecords("records", atlasId, target, records)`。
  5. `wrapUntrustedPageContent("read_records", atlasId, targetId, body)`。

**输出标签统一为 `<records>`**（取代 `collection_records` / `table_records`）。该标签是 `untrusted_page_content` 内的子元素、非顶层 untrusted wrapper，无需登记进 wrapper allowlist（旧的 `collection_records`/`table_records` 同样未登记）。

### nextActionsFor（render.ts）

```
collection | table   →  ["read_records"]
detail_region | region → ["read_target"]
```
（仅把 collection/table 的旧 action 名改为 read_records；detail_region/region 仍走 read_target——其 summary 模式是独立价值。）

### tool-names.ts（build-time invariant）

`PAGE_ATLAS_TOOL_NAMES`、`TOOL_CLASSES`、`TOOL_GROUPS` 三处穷举表：删 `read_collection`/`read_table`/`extract_records`，加 `read_records`（class=`read`，group=`core`）。**[M3-U4] / disclosure 不变量**：新工具名必须同时在 TOOL_CLASSES + TOOL_GROUPS 登记，否则 module load 时 throw——三表同步即满足。

### prompt.ts 工具目录

`READ_PAGE_GUIDANCE`（行 254）与 `find_target` 描述（target-tools.ts:277）里枚举旧工具名的文案改为 read_records / read_target。

## 改动面（精确）

| 文件 | 改动 |
|---|---|
| `tools/page-atlas/target-tools.ts` | 删 readCollectionTool/readTableTool/extractRecordsTool；加 readRecordsTool + `ReadRecordsArgs` 类型；返回数组改 `[findTargetTool, readRecordsTool, readTargetTool]`；改 find_target 描述文案 |
| `tools/page-atlas/render.ts` | `nextActionsFor` 两分支改名 |
| `agent/tool-names.ts` | 三张穷举表同步 |
| `agent/prompt.ts` | READ_PAGE_GUIDANCE 文案 |
| `tools/page-atlas/target-tools.test.ts` | 删 read_collection/read_table/extract_records 专属用例；加 read_records 用例（全记录 + fields 投影 + range 校验 + type-agnostic） |
| `agent/tool-names.test.ts` | 期望数组改 `[find_target, read_records, read_target]` |
| `agent/prompt.test.ts` | 断言旧工具名处改 read_records |
| `tools/read-page.test.ts` | 断言 atlas 输出含 "extract_records" 处改 "read_records" |
| `tools/search-page.test.ts` | tool-class 列表 + getToolClass 旧名改 read_records |

## 明确排除（YAGNI）

- **不动**安全边界逻辑（origin/fingerprint drift fail-closed）、`resolveTarget`、`selectedRecords`、`renderRecords`、`renderExtractedRecords`——仅复用。
- **不重命名** `read_target` 的 `target_text` 标签 / summary 模式。
- 历史 docs/specs 里的旧工具名不回改（归档，按日期前缀区分新旧）。

## 验收标准

- `read_records` 在 collection / table / detail_region 上都能读（不再有 collection vs table 猜错被拒）；`fields` 投影与全记录两条路径均正确。
- 旧三工具名从 tool 列表、tool-names 三表、prompt 文案中彻底移除。
- `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿（build-time invariant 不 throw）。
- 真机：read_page atlas → 对一个 table 目标调 read_records（无 fields）得全记录、带 fields 得投影（人工验收）。
