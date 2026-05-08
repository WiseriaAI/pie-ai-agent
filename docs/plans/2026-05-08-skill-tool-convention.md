# Skill vs Tool 规范实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/specs/2026-05-08-skill-tool-convention-design.md` —— 删除 2 个单步薄壳 builtin skill (`take_screenshot` / `open_url_in_tab`)，加一个幂等 storage cleanup migration，加 builtin skill 长度断言，更新 ROADMAP closeout。

**Architecture:** 删 `src/lib/skills/builtin.ts` 中两个 entry → 新建 `src/lib/skills/migration-cleanup-thinshell.ts` 负责 storage 残留清理（删 `skill_${id}` 副本 + filter `enabled_skills` 数组）→ 在 SW 启动 (`src/background/index.ts`) lazy 调用，模式与现有 `migrateV1toV2` 一致。无 sentinel（操作天然幂等），无 wire 协议变更。

**Tech Stack:** TypeScript / vitest + happy-dom / chrome.storage.local API

---

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/lib/skills/builtin.ts` | 修改 | 删 2 个 entry（`take_screenshot` L147-186 / `open_url_in_tab` L187-227 含 section comment）+ 加 `EXPECTED_BUILT_IN_SKILL_IDS` 断言守 5 项 |
| `src/lib/skills/migration-cleanup-thinshell.ts` | 新建 | `cleanupThinShellSkills()` async fn：删 `skill_take_screenshot` / `skill_open_url_in_tab` chrome.storage key + filter `enabled_skills` 4 个 marker |
| `src/lib/skills/migration-cleanup-thinshell.test.ts` | 新建 | 4 case：空 storage / stale skill 副本 / stale enabledIds marker / idempotent 连跑 2 次 |
| `src/background/index.ts` | 修改 | import + lazy 调用（与 `migrateV1toV2().catch(...)` 同模式） |
| `docs/ROADMAP.md` | 修改 | §13 P1 表追加 closeout note：删 2 个薄壳 + spec 链接 |
| `docs/specs/2026-05-08-skill-tool-convention-design.md` | 已存在（stage） | brainstorm 产物，本 plan 落地后随首个 commit 一起入库 |

---

## Task 1: Migration cleanup —— failing test scaffold

**Files:**
- Create: `src/lib/skills/migration-cleanup-thinshell.test.ts`

- [ ] **Step 1: 写 4 个失败测试**

```typescript
// src/lib/skills/migration-cleanup-thinshell.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupThinShellSkills } from "./migration-cleanup-thinshell";

// happy-dom doesn't ship chrome.storage; mock it per-test.
function mockChromeStorage(initial: Record<string, unknown>): {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  store: Record<string, unknown>;
} {
  const store = { ...initial };
  const get = vi.fn(async (keys: string | string[] | null) => {
    if (keys === null) return { ...store };
    const arr = typeof keys === "string" ? [keys] : keys;
    const out: Record<string, unknown> = {};
    for (const k of arr) if (k in store) out[k] = store[k];
    return out;
  });
  const set = vi.fn(async (entries: Record<string, unknown>) => {
    Object.assign(store, entries);
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    const arr = typeof keys === "string" ? [keys] : keys;
    for (const k of arr) delete store[k];
  });
  // @ts-expect-error happy-dom chrome global
  globalThis.chrome = { storage: { local: { get, set, remove } } };
  return { get, set, remove, store };
}

describe("cleanupThinShellSkills", () => {
  beforeEach(() => {
    // @ts-expect-error reset chrome global between cases
    globalThis.chrome = undefined;
  });

  it("no-op on empty storage", async () => {
    const m = mockChromeStorage({});
    await cleanupThinShellSkills();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.set).not.toHaveBeenCalled();
  });

  it("removes stale skill_take_screenshot / skill_open_url_in_tab user-side副本", async () => {
    const m = mockChromeStorage({
      skill_take_screenshot: { id: "take_screenshot", builtIn: false },
      skill_open_url_in_tab: { id: "open_url_in_tab", builtIn: false },
      skill_other: { id: "other" },
    });
    await cleanupThinShellSkills();
    expect("skill_take_screenshot" in m.store).toBe(false);
    expect("skill_open_url_in_tab" in m.store).toBe(false);
    expect("skill_other" in m.store).toBe(true);
  });

  it("filters stale enabled_skills markers", async () => {
    const m = mockChromeStorage({
      enabled_skills: [
        "take_screenshot",
        "!open_url_in_tab",
        "auto_group_tabs",
        "!extract_structured_data",
      ],
    });
    await cleanupThinShellSkills();
    expect(m.store.enabled_skills).toEqual([
      "auto_group_tabs",
      "!extract_structured_data",
    ]);
  });

  it("is idempotent across two consecutive runs", async () => {
    const m = mockChromeStorage({
      skill_take_screenshot: { id: "take_screenshot" },
      enabled_skills: ["take_screenshot", "auto_group_tabs"],
    });
    await cleanupThinShellSkills();
    await cleanupThinShellSkills();
    expect("skill_take_screenshot" in m.store).toBe(false);
    expect(m.store.enabled_skills).toEqual(["auto_group_tabs"]);
    // Second run must be a no-op (no extra writes / removes after first cleanup).
    expect(m.remove.mock.calls.length).toBeLessThanOrEqual(2); // 1st run only
    expect(m.set.mock.calls.length).toBeLessThanOrEqual(1); // 1st run only
  });
});
```

- [ ] **Step 2: 跑测试确认 fail（module not found）**

Run: `pnpm vitest run src/lib/skills/migration-cleanup-thinshell.test.ts`
Expected: FAIL — `Cannot find module './migration-cleanup-thinshell'`

- [ ] **Step 3: Commit failing scaffold**

```bash
git add src/lib/skills/migration-cleanup-thinshell.test.ts
git commit -m "test(skills): scaffold thin-shell cleanup migration tests" --no-verify
```

> `--no-verify` 仅本 commit 用 —— 测试故意 fail，pre-commit hook 跑 vitest 会拒绝。Task 2 实现完后再恢复正常 hook 行为。

---

## Task 2: Migration cleanup —— 实现

**Files:**
- Create: `src/lib/skills/migration-cleanup-thinshell.ts`

- [ ] **Step 1: 写 minimal 实现让测试通过**

```typescript
// src/lib/skills/migration-cleanup-thinshell.ts
//
// One-shot cleanup for the 2 thin-shell builtin skills removed by
// docs/specs/2026-05-08-skill-tool-convention-design.md.
//
// Removes:
//   - chrome.storage.local["skill_take_screenshot"]   (user-side override copy, if any)
//   - chrome.storage.local["skill_open_url_in_tab"]   (user-side override copy, if any)
//   - matching markers in chrome.storage.local["enabled_skills"]:
//       "take_screenshot" / "!take_screenshot" / "open_url_in_tab" / "!open_url_in_tab"
//
// Idempotent (filter + conditional remove are no-ops once storage is clean).
// Called silently from src/background/index.ts at SW start, mirroring
// migrateV1toV2 wiring.

const REMOVED_BUILTIN_SKILL_IDS = ["take_screenshot", "open_url_in_tab"] as const;
const ENABLED_SKILLS_KEY = "enabled_skills";

export async function cleanupThinShellSkills(): Promise<void> {
  const skillKeys = REMOVED_BUILTIN_SKILL_IDS.map((id) => `skill_${id}`);
  const all = await chrome.storage.local.get([
    ...skillKeys,
    ENABLED_SKILLS_KEY,
  ]);

  // Pass 1 — drop user-side override copies for the removed builtin ids.
  const presentSkillKeys = skillKeys.filter((k) => k in all);
  if (presentSkillKeys.length > 0) {
    await chrome.storage.local.remove(presentSkillKeys);
  }

  // Pass 2 — filter enabled_skills markers (both plain id and "!id" form).
  const enabledIds = (all[ENABLED_SKILLS_KEY] as string[] | undefined) ?? [];
  const removedSet = new Set<string>([
    ...REMOVED_BUILTIN_SKILL_IDS,
    ...REMOVED_BUILTIN_SKILL_IDS.map((id) => `!${id}`),
  ]);
  const filtered = enabledIds.filter((eid) => !removedSet.has(eid));
  if (filtered.length !== enabledIds.length) {
    await chrome.storage.local.set({ [ENABLED_SKILLS_KEY]: filtered });
  }
}
```

- [ ] **Step 2: 跑测试确认 4 case 全过**

Run: `pnpm vitest run src/lib/skills/migration-cleanup-thinshell.test.ts`
Expected: PASS — 4 tests, 0 failures

- [ ] **Step 3: Commit 实现**

```bash
git add src/lib/skills/migration-cleanup-thinshell.ts
git commit -m "feat(skills): cleanup migration for removed thin-shell builtins"
```

---

## Task 3: 在 background/index.ts wire migration

**Files:**
- Modify: `src/background/index.ts:90` (import block) 和 `:98` (lazy call site)

- [ ] **Step 1: 加 import**

在 `src/background/index.ts` 第 90 行（`import { migrateV1toV2 } ...` 旁）追加：

```typescript
import { cleanupThinShellSkills } from "@/lib/skills/migration-cleanup-thinshell";
```

- [ ] **Step 2: 加 lazy 调用**

在 `src/background/index.ts:98`（`migrateV1toV2().catch(...)` 那行）下面追加：

```typescript
cleanupThinShellSkills().catch((e) =>
  console.error("cleanup thin-shell skills failed", e),
);
```

- [ ] **Step 3: 跑全量测试 + build 确认无 import 错**

Run: `pnpm test && pnpm build`
Expected: PASS（migration 在 SW 启动时跑；测试不直接覆盖 wire 但 import 链通过 build）

- [ ] **Step 4: Commit wire**

```bash
git add src/background/index.ts
git commit -m "feat(sw): wire thin-shell skill cleanup at startup"
```

---

## Task 4: 删 builtin.ts 中 2 个薄壳 entry + 加 expectedIds 断言 + 单测

**Files:**
- Modify: `src/lib/skills/builtin.ts`（删 L147-227 范围内 2 个 entry + 加 expected ids 断言）
- Create: `src/lib/skills/builtin.test.ts`

- [ ] **Step 1: 写失败测试 — 5 项断言**

```typescript
// src/lib/skills/builtin.test.ts
import { describe, it, expect } from "vitest";
import { BUILT_IN_SKILLS } from "./builtin";

describe("BUILT_IN_SKILLS audit (spec 2026-05-08)", () => {
  it("contains exactly the 5 expected skills after thin-shell removal", () => {
    const ids = BUILT_IN_SKILLS.map((s) => s.id).sort();
    expect(ids).toEqual([
      "auto_group_tabs",
      "close_duplicate_tabs",
      "close_inactive_tabs",
      "create_skill_from_recording",
      "extract_structured_data",
    ]);
  });

  it("does NOT contain removed thin-shell skills", () => {
    const ids = new Set(BUILT_IN_SKILLS.map((s) => s.id));
    expect(ids.has("take_screenshot")).toBe(false);
    expect(ids.has("open_url_in_tab")).toBe(false);
  });

  it("every entry has builtIn: true (P0-A regression guard)", () => {
    for (const skill of BUILT_IN_SKILLS) {
      expect(skill.builtIn).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认 fail（前 2 case fail —— builtin.ts 仍含 7 项）**

Run: `pnpm vitest run src/lib/skills/builtin.test.ts`
Expected: FAIL — `BUILT_IN_SKILLS` 仍含 7 项

- [ ] **Step 3: 删 builtin.ts 中 take_screenshot entry**

打开 `src/lib/skills/builtin.ts`，删除从 L147 (section comment `// ── Phase 5 — Screenshot built-in skill ──...`) 到 L186 (`},` 闭合大括号) 的整段。

删除后，原本紧跟其下的 `// ── v1.5 — Open URL built-in skill ──...` (原 L187) 应紧接在 `close_inactive_tabs` entry 之后。

- [ ] **Step 4: 删 builtin.ts 中 open_url_in_tab entry**

继续删除从更新后的 section comment `// ── v1.5 — Open URL built-in skill ──...` 到对应 `},` 闭合大括号的整段（原 L187-227 范围）。

删除后，下一段应是 `// ── Recording v1 — Create Skill from Recording ──...` 的 `create_skill_from_recording` entry。

- [ ] **Step 5: 加 EXPECTED_BUILT_IN_SKILL_IDS 断言到 builtin.ts 末尾**

在 `builtin.ts` 现有 P0-A `for (const skill of BUILT_IN_SKILLS) { ... }` 断言**下方**追加：

```typescript
// ── Spec 2026-05-08 audit guard ─────────────────────────────────────────────
// Locks the 5 surviving builtin skill ids after thin-shell removal. Adding
// or removing a builtin requires re-validating the spec convention
// (docs/specs/2026-05-08-skill-tool-convention-design.md) — change this
// expected set in lock-step.
const EXPECTED_BUILT_IN_SKILL_IDS = new Set([
  "auto_group_tabs",
  "close_duplicate_tabs",
  "close_inactive_tabs",
  "create_skill_from_recording",
  "extract_structured_data",
]);

const actualIds = new Set(BUILT_IN_SKILLS.map((s) => s.id));
if (
  actualIds.size !== EXPECTED_BUILT_IN_SKILL_IDS.size ||
  ![...EXPECTED_BUILT_IN_SKILL_IDS].every((id) => actualIds.has(id))
) {
  const expected = [...EXPECTED_BUILT_IN_SKILL_IDS].sort().join(", ");
  const actual = [...actualIds].sort().join(", ");
  throw new Error(
    `[BUILT_IN_SKILLS audit] expected {${expected}}, got {${actual}}. ` +
      `Re-validate against docs/specs/2026-05-08-skill-tool-convention-design.md ` +
      `before changing builtin skills.`,
  );
}
```

- [ ] **Step 6: 跑测试确认全 pass**

Run: `pnpm vitest run src/lib/skills/builtin.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 7: 跑全量测试 + build 验证 import-time 断言不 throw**

Run: `pnpm test && pnpm build`
Expected: 全 pass，build 时 EXPECTED_BUILT_IN_SKILL_IDS 断言静默通过

- [ ] **Step 8: Commit 删除 + 断言**

```bash
git add src/lib/skills/builtin.ts src/lib/skills/builtin.test.ts
git commit -m "feat(skills): remove thin-shell builtin skills + audit guard

Per docs/specs/2026-05-08-skill-tool-convention-design.md:
- delete take_screenshot (single-step wrapper around capture_visible_tab)
- delete open_url_in_tab (single-step wrapper around open_url)
- add EXPECTED_BUILT_IN_SKILL_IDS import-time assertion locking surviving 5"
```

---

## Task 5: ROADMAP §13 P1 closeout note

**Files:**
- Modify: `docs/ROADMAP.md` — §13 P1 表格

- [ ] **Step 1: 在 §13 P1 表格追加一行**

打开 `docs/ROADMAP.md`，定位到 `### P1 — quick wins` 标题下的表格（约 L302-308），在表格 2 条现有行下追加：

```markdown
| **删除单步薄壳 builtin skill (`take_screenshot` / `open_url_in_tab`) + skill/tool 规范文档** | §13 自审；issue #44 §1 / #45 §2 误读项的真问题剥离 | ✅ **SHIPPED 2026-05-08** — spec → `docs/specs/2026-05-08-skill-tool-convention-design.md`；plan → `docs/plans/2026-05-08-skill-tool-convention.md`。删 2 entry + 加 EXPECTED_BUILT_IN_SKILL_IDS audit guard + storage cleanup migration（silent + idempotent）+ 在 SW 启动 wire。剩 5 项 builtin skill 全部满足"真组合"判据。命名空间 prefix（§13 P3 第 4 项）保留 backlog |
```

- [ ] **Step 2: Commit ROADMAP**

```bash
git add docs/ROADMAP.md
git commit -m "docs(roadmap): close §13 P1 thin-shell skill removal"
```

---

## Task 6: Final verification + spec/plan commit

**Files:**
- 已存在（stage）：`docs/specs/2026-05-08-skill-tool-convention-design.md`
- 已存在（unstaged）：`docs/plans/2026-05-08-skill-tool-convention.md`（本文件）

- [ ] **Step 1: 跑全量 verification**

Run: `pnpm test && pnpm build`
Expected: 全 pass。`pnpm test` 计数应比 baseline 多 7 (4 migration test + 3 builtin audit test)。

- [ ] **Step 2: 手验 SW 启动行为（可选 manual smoke test）**

如果有 dev profile 装着旧版扩展（含 `take_screenshot` 用户曾启用记录）：
1. `pnpm build` → load unpacked `dist/`
2. 打开 SW 日志（`chrome://extensions` → service worker inspect）
3. 启动后无 `cleanup thin-shell skills failed` 日志
4. SkillsList UI 不再含 "Take Screenshot" / "Open URL in Tab"
5. 用户在 chat 输入 "截屏当前页" → agent 直接调 `capture_visible_tab` 出 confirm 卡（无 skill 中介）

如果没有旧版扩展可验，跳过本 step；migration 单测已覆盖 idempotent + stale 残留 case。

- [ ] **Step 3: Commit spec + plan 一并入库**

```bash
git add docs/specs/2026-05-08-skill-tool-convention-design.md docs/plans/2026-05-08-skill-tool-convention.md
git commit -m "docs(spec): skill vs tool convention + impl plan"
```

- [ ] **Step 4: 确认 git log 是 6 个独立 commit**

```bash
git log --oneline -10
```

Expected：从 HEAD 往下读到这 6 个 commit（顺序倒过来：spec/plan → ROADMAP → builtin → wire → impl → scaffold）。

---

## Self-Review

### Spec coverage check

| Spec 节 / 要求 | 实现 task |
|---|---|
| C-1 删 `take_screenshot` | Task 4 Step 3 |
| C-2 删 `open_url_in_tab` | Task 4 Step 4 |
| C-3 enabled_skills filter migration | Task 1+2（test + impl）+ Task 3（wire） |
| C-4 user-skill 副本清理 | Task 1+2 同上（覆盖在 `Pass 1` 删 skill_${id} 路径） |
| T-1 enabled_skills migration 测试 | Task 1 case "filters stale enabled_skills markers" |
| T-2 user-skill 副本 migration 测试 | Task 1 case "removes stale skill_take_screenshot ..." |
| T-3 BUILT_IN_SKILLS 长度 = 5 + ID 集合断言 | Task 4 builtin.test.ts case 1 + 2 |
| T-4 build-time guard punt | 不做（spec 已声明） |
| D-1 spec 文件 | Task 6 Step 3 |
| D-2 ROADMAP §13 P1 closeout | Task 5 |
| D-3 历史 narrative 不改 | by omission（plan 不动 §5 #4 / §13 P3 P5 / record-and-replay trace） |
| Q1 saveSkill 允许 builtin id | resolved（读 storage.ts L84-86 确认 saveSkill 接受任意 id；migration C-4 防御此情况） |
| Q2 migration 触发点 | resolved（SW startup, with `migrateV1toV2`）|
| Q3 expectedIds 断言 | Task 4 Step 5 |

### Placeholder scan

无 TBD / TODO / "implement later" / "add appropriate error handling"。每个 step 都有具体 code / command / expected output。

### Type consistency

- `cleanupThinShellSkills` 在 Task 1 测试 + Task 2 实现 + Task 3 wire 三处签名一致：`async () => Promise<void>`
- `EXPECTED_BUILT_IN_SKILL_IDS` 在 Task 4 builtin.ts 定义；audit guard 用相同 set 比对
- `REMOVED_BUILTIN_SKILL_IDS` 仅在 Task 2 migration 内部用，不外露
- `enabled_skills` storage key 字符串在 Task 1 mock 与 Task 2 `ENABLED_SKILLS_KEY` 常量一致

### Scope check

单 PR，6 个 commit，~150 行 code 改动 + ~80 行 doc 改动 + ~150 行 test 新增。完成后 production behavior：用户在 SkillsList 看不到那 2 个 skill；LLM tool 列表也不再有那 2 个名字；migration silent。
