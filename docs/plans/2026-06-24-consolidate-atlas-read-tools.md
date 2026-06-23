# Consolidate Atlas Read Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `read_collection` + `read_table` + `extract_records` 合并成单个 type-dispatched `read_records({atlas_id, target_id, range?, fields?})`，保留 `find_target` / `read_target`（5→3 工具），消除「collection vs table 猜错类型被拒」路径。

**Architecture:** 行为保持的重命名重构。新工具复用全部既有 helper（`resolveTarget` / `selectedRecords` / `renderRecords` / `renderExtractedRecords` / `wrapUntrustedPageContent`），仅按 `fields` 是否给出在「全记录 XML」与「投影 JSON」两条已存在路径间分流。工具工厂与 `tool-names.ts` 三张穷举表强耦合 + 测试跨 5 文件，故作为**一个内聚原子改动**落地（测试先行 → 红 → 实现 → 绿）。

**Tech Stack:** TypeScript、vitest + happy-dom。

## Global Constraints

- **不改**安全/校验逻辑：`resolveTarget`、`selectedRecords`、`renderRecords`、`renderExtractedRecords`、origin/fingerprint fail-closed 全部复用。
- **build-time invariant**：`tool-names.ts` 里 `PAGE_ATLAS_TOOL_NAMES` / `TOOL_CLASSES` / `TOOL_GROUPS` 三表必须同步——任何工具名在 TOOL_CLASSES 缺失或 TOOL_GROUPS 缺失，module load 即 throw（[M3-U4] / disclosure）。
- `read_records` 参数：`{atlas_id, target_id, range?, fields?: string[]}`；`allowedTypes = ["collection","table","detail_region"]`；无 `fields`/空 → `renderRecords("records", …)` 全记录 XML；`fields` 非空 → `renderExtractedRecords(records, fields)` 投影 JSON。
- 提交前：`pnpm test`、`pnpm typecheck`、`pnpm build` 全绿。

---

### Task 1: 合并三工具为 read_records（含全部源 + 测试）

**Files:**
- Modify: `src/lib/agent/tools/page-atlas/target-tools.ts`（删 3 工具、加 readRecordsTool + ReadRecordsArgs、改 return 数组、改 find_target 描述）
- Modify: `src/lib/agent/tools/page-atlas/render.ts`（`nextActionsFor`）
- Modify: `src/lib/agent/tool-names.ts`（三张穷举表）
- Modify: `src/lib/agent/prompt.ts`（READ_PAGE_GUIDANCE 文案）
- Test: `src/lib/agent/tools/page-atlas/target-tools.test.ts`
- Test: `src/lib/agent/tool-names.test.ts`
- Test: `src/lib/agent/prompt.test.ts`
- Test: `src/lib/agent/tools/read-page.test.ts`
- Test: `src/lib/agent/tools/search-page.test.ts`

**Interfaces:**
- Consumes（复用，签名不变）：`resolveTarget(store, getPageState, ctx, atlasId, targetId, allowedTypes)`、`selectedRecords(records, range) → {ok, records|error}`、`renderRecords(tag, atlasId, target, records) → string`、`renderExtractedRecords(records, keys: string[]) → string`、`wrapUntrustedPageContent(tool, atlasId, targetId, body) → string`、`isNonEmptyString(v): v is string`、`fail(msg)`、`ok(observation)`、`READ_PAGE_FIRST`。
- Produces：tool `read_records`（class `read`，group `core`）；`createPageAtlasTargetTools()` 返回 `[findTargetTool, readRecordsTool, readTargetTool]`。

- [ ] **Step 1: 改测试 —— target-tools.test.ts**

把 `target-tools.test.ts` 中行 **205–307** 的全部 read_collection / read_table / extract_records 用例，替换为下面这组 read_records 用例（覆盖：全记录、type-agnostic 读 table、fields 投影、range 校验、必填校验、不支持类型）：

```typescript
  it("read_records returns full records for a collection (no fields)", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler(
      { atlas_id: "atlas_1", target_id: "collection_c1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.observation).toContain('tool="read_records"');
    expect(result.observation).toContain("<records");
    expect(result.observation).toContain("record_r1");
    expect(result.observation).toContain("record_r2");
    expect(result.observation).toContain("&quot;Pie&quot;");
  });

  it("read_records reads a table without pre-classifying the type", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler(
      { atlas_id: "atlas_1", target_id: "table_t1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.observation).toContain('tool="read_records"');
    expect(result.observation).toContain("record_t1");
    expect(result.observation).toContain("PIE-1");
  });

  it("read_records returns the selected range only", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler(
      { atlas_id: "atlas_1", target_id: "collection_c1", range: "1..2" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.observation).not.toContain("record_r1");
    expect(result.observation).toContain("record_r2");
    expect(result.observation).toContain("&quot;Cake&quot;");
  });

  it("read_records projects to named fields when fields given", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler(
      { atlas_id: "atlas_1", target_id: "collection_c1", fields: ["name"], range: "0..1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.observation).toContain('tool="read_records"');
    expect(untrustedPageContentBody(result.observation ?? "")).toBe(
      '[{&quot;name&quot;:&quot;Pie&quot;,&quot;_evidence&quot;:&quot;first product card&quot;}]',
    );
    expect(result.observation).not.toContain("price");
  });

  it("read_records treats an empty fields array as full records", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler(
      { atlas_id: "atlas_1", target_id: "collection_c1", fields: [] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.observation).toContain("<records");
    expect(result.observation).toContain("price");
  });

  it("read_records rejects malformed ranges", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler(
      { atlas_id: "atlas_1", target_id: "collection_c1", range: "abc" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_range: expected range like 0..10");
  });

  it("read_records rejects reversed ranges", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler(
      { atlas_id: "atlas_1", target_id: "collection_c1", range: "3..1" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_range: expected range like 0..10");
  });

  it("read_records requires atlas and target", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler({ fields: ["name"] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("read_page");
  });

  it("read_records fails closed for an unsupported target type (region)", async () => {
    const tools = toolsFor(store);
    const result = await tools.read_records.handler(
      { atlas_id: "atlas_1", target_id: "region_r1" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("expected collection or table or detail_region");
  });
```

然后把后面安全/边界测试里所有 `tools.read_collection.handler` 改为 `tools.read_records.handler`，以及 `tools.find((tool) => tool.name === "read_collection")` 改为 `"read_records"`：
- 行 **328**（origin drift）`tools.read_collection.handler` → `tools.read_records.handler`
- 行 **377**（tab URL reject）`name === "read_collection"` → `name === "read_records"`
- 行 **397**（fingerprint fail）`tools.read_collection.handler` → `tools.read_records.handler`
- 行 **444**（hostile escaping）`tools.read_collection.handler` → `tools.read_records.handler`

删除原「fails closed for unsupported target type」用例（行 **406–416**，断言 `expected collection`）——已被上面新的 region 版本取代。

- [ ] **Step 2: 改测试 —— 其余 4 个测试文件**

`tool-names.test.ts` 行 **80–86** 期望数组：

```typescript
    expect(PAGE_ATLAS_TOOL_NAMES).toEqual([
      "find_target",
      "read_records",
      "read_target",
    ]);
```

`prompt.test.ts` 行 **367–371**，替换为：

```typescript
    expect(prompt).toContain("`read_records`");
    expect(prompt).toContain("`read_target`");
    expect(prompt).toMatch(/read_records.*fields/is);
```
（删除 `read_collection` / `read_table` / `extract_records` / `extract_records.*target-level only` 四条断言。）

`read-page.test.ts` 行 **172**：

```typescript
    expect(result.observation).toContain("read_records");
```
（原为 `toContain("extract_records")`——atlas 输出的 next_action 现广告 read_records。）

`search-page.test.ts` 行 **254–268**，替换 atlas 工具名列表与 class 断言：

```typescript
    expect(BUILT_IN_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "read_page",
        "find_target",
        "read_records",
        "read_target",
      ]),
    );
    expect(getToolClass("find_target")).toBe("read");
    expect(getToolClass("read_records")).toBe("read");
    expect(getToolClass("read_target")).toBe("read");
```

- [ ] **Step 3: 跑测试确认 RED**

Run: `pnpm test src/lib/agent/tools/page-atlas/target-tools.test.ts src/lib/agent/tool-names.test.ts`
Expected: FAIL（`read_records` 工具尚不存在 / 旧名仍在三表 → `tools.read_records` undefined、PAGE_ATLAS_TOOL_NAMES 不匹配）。

- [ ] **Step 4: 实现 —— target-tools.ts**

(a) 删除 `ExtractRecordsArgs` interface（行 32–37），新增：

```typescript
interface ReadRecordsArgs {
  atlas_id?: unknown;
  target_id?: unknown;
  range?: unknown;
  fields?: unknown;
}
```

(b) 删除整个 `readCollectionTool`（行 321–359）、`readTableTool`（行 361–398）、`extractRecordsTool`（行 450–494），在 `readTargetTool` 之后新增：

```typescript
  const readRecordsTool: Tool = {
    name: "read_records",
    description:
      `Read records from a collection, table, or detail_region target, rendered by the target's actual type — so you don't pre-classify collection vs table. By default returns full records (every field + text per item); pass "fields" to project down to just the named fields (cheaper for large lists). Requires atlas_id + target_id from read_page({mode:"atlas"}).

USE WHEN:
- The target's type is "collection", "table", or "detail_region" and you need its records.
- You want all fields per item (omit "fields"), or only specific fields (pass "fields").

**DO NOT USE WHEN:**
- You want a block overview or a plain free-text region — use read_target.`,
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        range: { type: "string", description: "Optional 0-based half-open range like 0..10." },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Optional field names to keep; omit to return full records.",
        },
      },
      required: ["atlas_id", "target_id"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as ReadRecordsArgs;
      if (!isNonEmptyString(a.atlas_id) || !isNonEmptyString(a.target_id)) {
        return fail(`read_records requires atlas_id and target_id. ${READ_PAGE_FIRST}`);
      }
      const resolved = await resolveTarget(store, getPageState, ctx, a.atlas_id, a.target_id, [
        "collection",
        "table",
        "detail_region",
      ]);
      if (!resolved.ok) return fail(resolved.error);
      const selected = selectedRecords(resolved.target.records, a.range);
      if (!selected.ok) return fail(selected.error);
      const fields = Array.isArray(a.fields) ? a.fields.filter(isNonEmptyString) : [];
      const body =
        fields.length > 0
          ? renderExtractedRecords(selected.records, fields)
          : renderRecords("records", resolved.atlas.atlasId, resolved.target, selected.records);
      return ok(wrapUntrustedPageContent("read_records", resolved.atlas.atlasId, resolved.target.id, body));
    },
  };
```

(c) `find_target` 描述（行 277）改为：

```typescript
- You want the records themselves, not a target_id — use read_records or read_target.`,
```

(d) return 语句（行 496）改为：

```typescript
  return [findTargetTool, readRecordsTool, readTargetTool];
```

- [ ] **Step 5: 实现 —— render.ts `nextActionsFor`**

```typescript
function nextActionsFor(target: AtlasTarget): string[] {
  if (target.type === "collection" || target.type === "table") return ["read_records"];
  return ["read_target"];
}
```

- [ ] **Step 6: 实现 —— tool-names.ts 三张穷举表**

- `PAGE_ATLAS_TOOL_NAMES`（行 95–101）：删 `"read_collection"` / `"read_table"` / `"extract_records"`，整理为：
```typescript
export const PAGE_ATLAS_TOOL_NAMES = [
  "find_target",
  "read_records",
  "read_target",
] as const;
```
- `TOOL_CLASSES`（行 253–256）：删 `read_collection` / `read_table` / `extract_records` 三行，加 `read_records: "read",`。
- `TOOL_GROUPS`（行 338–339）：删 `read_collection` / `read_table` / `extract_records`，加 `read_records: "core",`。

- [ ] **Step 7: 实现 —— prompt.ts READ_PAGE_GUIDANCE（行 254）**

把这句：
> `then read the target with \`read_collection\`, \`read_table\`, or \`read_target\`, or extract structured rows with \`extract_records\`. \`extract_records\` is target-level only: always pass an \`atlas_id\`, a \`target_id\`, and a schema object.`

替换为：
> `then read the target's records with \`read_records\` (pass \`fields\` to keep only specific fields), or read a detail block / free-text region with \`read_target\`. \`read_records\` and \`read_target\` are target-level: always pass an \`atlas_id\` and a \`target_id\`.`

- [ ] **Step 8: 跑测试确认 GREEN**

Run: `pnpm test src/lib/agent/tools/page-atlas/target-tools.test.ts src/lib/agent/tool-names.test.ts src/lib/agent/prompt.test.ts src/lib/agent/tools/read-page.test.ts src/lib/agent/tools/search-page.test.ts`
Expected: PASS（全部）。

- [ ] **Step 9: typecheck**

Run: `pnpm typecheck`
Expected: 0 错（`ExtractRecordsArgs` 已删且无残留引用；`ReadRecordsArgs` 已定义）。

- [ ] **Step 10: 提交**

```bash
git add src/lib/agent/tools/page-atlas/target-tools.ts \
        src/lib/agent/tools/page-atlas/render.ts \
        src/lib/agent/tool-names.ts \
        src/lib/agent/prompt.ts \
        src/lib/agent/tools/page-atlas/target-tools.test.ts \
        src/lib/agent/tool-names.test.ts \
        src/lib/agent/prompt.test.ts \
        src/lib/agent/tools/read-page.test.ts \
        src/lib/agent/tools/search-page.test.ts
git commit -m "feat(page-atlas): consolidate read_collection/read_table/extract_records into read_records (#162)"
```

---

### Task 2: 全量验证

- [ ] **Step 1: 全量 test + typecheck + build**

```bash
pnpm test && pnpm typecheck && pnpm build
```
Expected: 全绿（build-time invariant 不 throw；无任何残留的 read_collection/read_table/extract_records 引用）。

- [ ] **Step 2: 残留引用扫描**

```bash
rg -n "read_collection|read_table|extract_records|collection_records|table_records" src
```
Expected: 仅可能命中历史无关项；**src 下不应再有这三个工具名的活跃引用**（docs 归档不算）。若有遗漏，补改后重跑 Step 1。
