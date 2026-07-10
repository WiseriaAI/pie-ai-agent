# Skill 体系（有本地 daemon）— Slice 2：扩展 SkillSource 重构 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展侧接入 Slice 1 的 daemon skill-fs：`SkillSource` 抽象（IDB / daemon-磁盘双后端 + builtin 只读层）让 catalog、use_skill/read_skill_file、skill CRUD、run_skill_script、slash、SkillsList 全部走 active source——daemon 连上且有 `skill_fs` → 磁盘为真源，否则 IDB 现状；首次进磁盘模式把 IDB 用户 skill 一次性迁盘。

**Architecture:** `src/lib/skills/source.ts` 定义 `SkillEntry`/`SkillSource` + `IdbSkillSource`（包住现有 skill-store）+ builtin 合并层（`withBuiltins`）+ enabled 过滤纯函数；`src/background/daemon-skill-source.ts` 是桥客户端后端；`src/background/skill-source.ts` 按 `skill_fs` capability 选后端。SW 内消费者（loop catalog / 3 组 skill 工具）直调 active source；panel 消费者（Chat slash / SkillsList）经 `skills-action` RPC（`swPort.request` → SW handler，镜像 schedules panel-actions 模式）——**两模式同一条 panel 数据路径**，消灭双真源。磁盘模式脚本执行走桥（`needs_authorization` 在本 slice 返回结构化错误；授权卡 = Slice 3）。

**Tech Stack:** TypeScript + React 19、vitest + happy-dom + fake-indexeddb（现有测试基座）、daemon 侧 bun test（仅 Task 1 触及）。

## Slice 上下文

- **Slice 1（已完成，daemon 侧）**：`~/.pie/skills/<name>/` 磁盘真源 + srt 沙箱执行 + per-skill 信封 grant + audit + 桥 7 方法 + `skill_fs` capability。HEAD `73cff912`，daemon 67 测试绿 + opus 终审 Ready-to-merge。
- **Slice 2（本 plan）**：扩展侧全接线 + 迁移。完成后磁盘模式端到端可用（脚本执行除授权卡外全通）。
- **Slice 3（待写）**：per-skill 信封授权卡（panel-request HITL kind + i18n 六字典）、设置页 grant 列举/撤销、audit 呈现。

---

## Global Constraints

（值取自 spec `docs/specs/2026-07-10-skill-system-with-local-daemon.md` 与 Slice 1 落地接口）

- **模式判定**：`isBridgeReady() && bridgeCapabilities().includes("skill_fs")` → 磁盘模式；否则 IDB 模式。判定封装在 `getActiveSkillSource()`（`src/background/skill-source.ts`），上层不重复判。
- **协议只增不改**：`PROTOCOL_VERSION` 仍 `1`；本 slice 唯一协议改动 = `SkillSummary` 加 `files: string[]`（加法）。`src/types/local-bridge.ts` 是唯一权威源。
- **builtin 只读层永远并入**：builtin 留扩展代码常量，两模式 catalog 同形合并；backend 同 id 覆盖 builtin（IDB 现状语义）。builtin 不落盘、不上 daemon。
- **enabled = 扩展侧 UI pref**（IDB config `enabled_skills`，marker 语义：plain=开 `!id`=关），两模式通用。**默认开政策**：`builtIn || origin === "disk"` 默认开（磁盘上放了 skill = 意图，对齐 Claude Code），IDB 用户 skill 默认关（现状）。
- **grant = daemon 侧**，扩展零 grant 存储。本 slice 不做授权卡：磁盘模式 `needs_authorization` → tool 返回结构化 error observation。
- **prompt injection 边界不动**：skill 正文/文件/脚本 stdout 一律包 `<untrusted_skill_content>`（`escapeUntrustedWrappers`）；catalog（name/description）进 system prompt 的现状语义保持。
- **工具 read/write 分类不动**（`tool-names.ts` 零改动；`run_skill_script` 已是 write）。
- **本 slice 零新增用户可见文案**（不碰 i18n 六字典；needs_authorization 错误是 LLM-facing 英文）。
- **IDB 模式行为不回归**：daemon 关/未装时全部现状（2a 纯计算路径、quota、P0-A/C/D、P1-E/H 防御全保留）。
- **迁移幂等**：磁盘已有同名目录则跳过不覆盖；IDB 原件保留作回退（磁盘模式不再读）。
- 门禁：`pnpm test` / `pnpm typecheck`（0 错）/ `pnpm build`；Task 1 另跑 `cd daemon && bun test`。
- 测试基座：vitest + happy-dom + fake-indexeddb；RTL 用房规 `afterEach(() => cleanup())`、无 jest-dom（`.toBeTruthy()`）。

---

## File Structure

- `src/types/local-bridge.ts` — 改：`SkillSummary.files`。
- `daemon/src/skill-store.ts` + `daemon/test/skill-store-read.test.ts` — 改：listSkills 枚举包内文件。
- `src/background/local-bridge.ts` + `local-bridge.test.ts` — 改：7 个 skill_fs 客户端方法 + `bridgeHasSkillFs` + `bridgeSettled` + error `.code` 透传。
- `src/lib/skills/source.ts`（新）+ `source.test.ts` — SkillEntry/SkillSource/IdbSkillSource/withBuiltins/filterEnabled/stripFrontmatter/kebabSlug。
- `src/background/daemon-skill-source.ts`（新）+ 测试 — 桥后端。
- `src/background/skill-source.ts`（新）+ 测试 — resolver + `getEnabledSkillEntries`。
- `src/lib/agent/tools/skill-access.ts` + 测试 — 改：走 source。
- `src/lib/agent/tools/skill-meta.ts` + 测试 — 改：双模式 CRUD。
- `src/lib/agent/tools/skill-script.ts` + 测试 — 改：磁盘分支走桥。
- `src/lib/agent/loop.ts` — 改：catalog 取数换 `getEnabledSkillEntries`。
- `src/lib/skills/panel-actions.ts`（新）+ `src/background/skills-action-handler.ts`（新）+ 测试 — panel RPC。
- `src/background/index.ts` — 改：onMessage 加 skills-action 分支 + 启动迁移钩子。
- `src/sidepanel/components/Chat.tsx` / `SkillsList.tsx` / `SkillSlashPopover.tsx`（如需）+ 测试 — 改：走 RPC。
- `src/lib/skills/slash.ts` — 改：签名适配 SkillEntry（如需）。
- `src/background/skill-migration.ts`（新）+ 测试 — IDB→磁盘迁移。

---

### Task 1: daemon — `SkillSummary.files`（包文件枚举）

> use_skill 的 refNote（"Additional files available via read_skill_file: …"）在磁盘模式需要文件清单；Slice 1 的 `list_skills` 没带。加法扩协议 + daemon 实现。

**Files:**
- Modify: `src/types/local-bridge.ts`（`SkillSummary`）
- Modify: `daemon/src/skill-store.ts`（`listSkills`）
- Test: `daemon/test/skill-store-read.test.ts`（追加）

**Interfaces:**
- Produces: `SkillSummary.files: string[]` — skill 目录内文件相对路径（POSIX `/` 分隔，含 `SKILL.md` 与 `scripts/*`，**排除** `workspace/` 与 `.runs/` 子树及点文件），上限 200 条。

- [ ] **Step 1: 写失败测试（追加到 skill-store-read.test.ts）**

```ts
test("listSkills enumerates package files, excluding workspace/.runs/dotfiles", () => {
  const root = tmpRoot();
  makeSkill(root, "s", `---\nname: s\ndescription: d\n---\nb\n`, ["run.ts"]);
  const dir = join(root, "s");
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "references", "guide.md"), "g");
  mkdirSync(join(dir, "workspace"), { recursive: true });
  writeFileSync(join(dir, "workspace", "out.txt"), "x");
  mkdirSync(join(dir, ".runs"), { recursive: true });
  writeFileSync(join(dir, ".runs", "tmp"), "x");
  writeFileSync(join(dir, ".DS_Store"), "x");
  const [s] = listSkills(root);
  expect(s.files.sort()).toEqual(["SKILL.md", "references/guide.md", "scripts/run.ts"]);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测确认失败** — `cd daemon && bun test test/skill-store-read.test.ts` → FAIL（`files` undefined）。

- [ ] **Step 3: 实现**

`src/types/local-bridge.ts` 的 `SkillSummary` 加：

```ts
  /** 包内文件相对路径（POSIX 分隔；排除 workspace/ 与 .runs/ 及点文件；上限 200） */
  files: string[];
```

`daemon/src/skill-store.ts` 加枚举函数并在 `listSkills` 组进 summary：

```ts
const FILES_CAP = 200;
const EXCLUDED_DIRS = new Set(["workspace", ".runs"]);

/** skill 目录内文件相对路径（递归；排除 workspace/.runs 与点文件；封顶 FILES_CAP）。 */
function packageFiles(skillDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (out.length >= FILES_CAP) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= FILES_CAP) return;
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (!prefix && EXCLUDED_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
      } else if (e.isFile()) {
        out.push(prefix ? `${prefix}/${e.name}` : e.name);
      }
    }
  };
  walk(skillDir, "");
  return out;
}
```

`listSkills` 的 `out.push({...})` 加 `files: packageFiles(dir),`。

- [ ] **Step 4: 跑测确认通过 + 全量** — `cd daemon && bun test` → 全绿；`pnpm typecheck` → 0 错（扩展侧若有构造 SkillSummary 的测试 fixture 需补 `files: []`）。

- [ ] **Step 5: Commit**

```bash
git add src/types/local-bridge.ts daemon/src/skill-store.ts daemon/test/skill-store-read.test.ts
git commit -m "feat(daemon): SkillSummary.files — enumerate package files for use_skill refNote"
```

---

### Task 2: 桥客户端 — skill_fs 方法 + `bridgeSettled` + error code 透传

**Files:**
- Modify: `src/background/local-bridge.ts`
- Test: `src/background/local-bridge.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 后的 `local-bridge.ts` 类型。
- Produces（Task 4/8/10 依赖）：
  ```ts
  export function bridgeHasSkillFs(): boolean;            // ready && capabilities 含 skill_fs
  export function bridgeSettled(): Promise<void>;          // 握手落定（成功或失败）后 resolve；从未 init → 立即 resolve
  export async function requestListSkills(): Promise<ListSkillsResult>;
  export async function requestReadSkillFile(p: ReadSkillFileParams): Promise<ReadSkillFileResult>;
  export type RunSkillScriptOutcome =
    | { ok: true; result: RunSkillScriptResult }
    | { ok: false; needsAuth: true }
    | { ok: false; needsAuth: false; error: string };
  export async function requestRunSkillScript(p: RunSkillScriptParams): Promise<RunSkillScriptOutcome>;
  export async function requestWriteSkill(p: WriteSkillParams): Promise<WriteSkillResult>;
  export async function requestDeleteSkill(p: DeleteSkillParams): Promise<DeleteSkillResult>;
  export async function requestListGrants(): Promise<ListGrantsResult>;      // Slice 3 消费，先备好
  export async function requestRevokeGrant(p: RevokeGrantParams): Promise<RevokeGrantResult>;
  ```
- daemon 错误码经 `send()` reject 的 Error 上以**非枚举** `.code` 属性透传（`Object.defineProperty(err, "code", { value, enumerable: false })`——非枚举防 JSON.stringify 把内部码带进 LLM 可见文案）。

- [ ] **Step 1: 写失败测试**

在 `local-bridge.test.ts` 现有 fake-port 基座上追加（沿用该文件既有的 connectNative mock 模式）：

```ts
it("requestRunSkillScript maps needs_authorization to { needsAuth: true }", async () => {
  // fake daemon 回 { ok:false, error:{ code:"needs_authorization", message:"authorization required" } }
  // → outcome = { ok:false, needsAuth:true }
});
it("requestRunSkillScript maps other errors to { needsAuth:false, error }", async () => {});
it("requestListSkills round-trips result.skills", async () => {});
it("bridgeHasSkillFs true only when ready && capability present", async () => {});
it("bridgeSettled resolves after handshake completes (and immediately when never inited)", async () => {});
```

每条测试体按文件内既有 hello/handshake 测试的 fake-port 写法补全：postMessage 捕获请求 → 手动回注响应 → 断言。

- [ ] **Step 2: 跑测确认失败** — `pnpm test -- src/background/local-bridge.test.ts` → FAIL。

- [ ] **Step 3: 实现**

`send()` 的 reject 改为携带 code：

```ts
      else {
        const err = new Error(msg.error.message);
        // 非枚举：防止 JSON.stringify(err) 把内部错误码泄进 LLM 可见文案
        Object.defineProperty(err, "code", { value: msg.error.code, enumerable: false });
        p.reject(err);
      }
```

握手落定 promise（`initLocalBridge` 内）：

```ts
let settledResolve: (() => void) | null = null;
let settledPromise: Promise<void> = Promise.resolve();

export function bridgeSettled(): Promise<void> {
  return settledPromise;
}
```

`initLocalBridge()` 开头（connectNative 成功后）：`settledPromise = new Promise((r) => { settledResolve = r; });`；`hello` 的 `.then`/`.catch` 末尾都调 `settledResolve?.(); settledResolve = null;`；connectNative 失败分支与 `disconnectLocalBridge()` 也置回已 resolve 状态（`settledResolve?.(); settledResolve = null;`）。

新方法（全部薄包 `send`）：

```ts
export function bridgeHasSkillFs(): boolean {
  return ready && capabilities.includes("skill_fs");
}

export async function requestListSkills(): Promise<ListSkillsResult> {
  return (await send("list_skills", {})) as ListSkillsResult;
}
export async function requestReadSkillFile(p: ReadSkillFileParams): Promise<ReadSkillFileResult> {
  return (await send("read_skill_file", p)) as ReadSkillFileResult;
}
export async function requestRunSkillScript(p: RunSkillScriptParams): Promise<RunSkillScriptOutcome> {
  try {
    return { ok: true, result: (await send("run_skill_script", p)) as RunSkillScriptResult };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "needs_authorization") return { ok: false, needsAuth: true };
    return { ok: false, needsAuth: false, error: e instanceof Error ? e.message : String(e) };
  }
}
export async function requestWriteSkill(p: WriteSkillParams): Promise<WriteSkillResult> {
  return (await send("write_skill", p)) as WriteSkillResult;
}
export async function requestDeleteSkill(p: DeleteSkillParams): Promise<DeleteSkillResult> {
  return (await send("delete_skill", p)) as DeleteSkillResult;
}
export async function requestListGrants(): Promise<ListGrantsResult> {
  return (await send("list_grants", {})) as ListGrantsResult;
}
export async function requestRevokeGrant(p: RevokeGrantParams): Promise<RevokeGrantResult> {
  return (await send("revoke_grant", p)) as RevokeGrantResult;
}
```

对应 type import 补进顶部 import 块。

- [ ] **Step 4: 跑测确认通过** — `pnpm test -- src/background/local-bridge.test.ts` → PASS（含既有用例零回归）。

- [ ] **Step 5: Commit**

```bash
git add src/background/local-bridge.ts src/background/local-bridge.test.ts
git commit -m "feat(sw): skill_fs bridge client methods + bridgeSettled + error-code passthrough"
```

---

### Task 3: `SkillSource` 抽象 + `IdbSkillSource` + builtin 层 + 纯函数（skills lib）

**Files:**
- Create: `src/lib/skills/source.ts`
- Test: `src/lib/skills/source.test.ts`

**Interfaces:**
- Consumes: 现有 `skill-store.ts`（listPackages/getPackage/putPackage/deletePackage）、`builtin.ts`（BUILT_IN_SKILL_PACKAGES）、`frontmatter.ts`（parseSkillMarkdown）、`script-decl.ts`（parseScriptDecls）。
- Produces（后续所有任务的核心契约）：
  ```ts
  export interface SkillEntry {
    id: string;                 // 调用身份（use_skill/read_skill_file 的 skillId）：builtin/idb = pkg.id；disk = 目录名
    name: string;
    description: string;
    builtIn: boolean;
    origin: "builtin" | "idb" | "disk";
    files: string[];            // 包内文件相对路径（含 SKILL.md）
    runnableScripts: string[];  // disk: scripts/ 文件名；idb/builtin: capabilities.scripts 声明 entry
    createdAt?: number;         // idb（slash 排序用）
    author?: string;
  }
  export interface SkillWriteFile { path: string; content: string; }
  export interface SkillSource {
    mode: "idb" | "disk";
    list(): Promise<SkillEntry[]>;                                  // 不含 builtin（withBuiltins 并入）
    readFile(id: string, path: string): Promise<string | null>;
    write(id: string, files: SkillWriteFile[]): Promise<void>;      // upsert；SKILL.md 必在 files 内（create 时）
    delete(id: string): Promise<boolean>;
  }
  export const idbSkillSource: SkillSource;
  export function withBuiltins(backend: SkillSource): SkillSource;  // list 合并（backend 同 id 覆盖 builtin）；readFile backend 优先、builtin 兜底；write/delete 透传
  export function filterEnabled(entries: SkillEntry[], markers: string[]): SkillEntry[];
  export function stripFrontmatter(md: string): string;             // 剥 --- fence，无 fence 原样返回；不校验字段
  export function kebabSlug(name: string): string;                  // 磁盘目录名 slug；结果匹配 /^[a-z0-9][a-z0-9-]*$/ 或 ""
  ```
- **filterEnabled 语义**（沿用 storage marker）：`!id` marker → false；plain `id` marker → true；无 marker → `entry.builtIn || entry.origin === "disk"`（磁盘默认开——文件放上去=意图，对齐 Claude Code；IDB 用户 skill 默认关=现状）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/skills/source.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  idbSkillSource, withBuiltins, filterEnabled, stripFrontmatter, kebabSlug,
  type SkillEntry, type SkillSource,
} from "./source";
import { putPackage, listPackages, deletePackage } from "./skill-store";
import { BUILT_IN_SKILL_PACKAGES } from "./builtin";
import type { SkillPackage } from "./package-types";

const pkg = (id: string, extra?: Partial<SkillPackage>): SkillPackage => ({
  id,
  frontmatter: { name: `Name ${id}`, description: `${id} desc` },
  files: { "SKILL.md": `---\nname: Name ${id}\ndescription: ${id} desc\n---\nBODY ${id}`, "references/a.md": "ref" },
  builtIn: false,
  createdAt: 42,
  ...extra,
});

describe("idbSkillSource", () => {
  beforeEach(async () => {
    for (const p of await listPackages()) await deletePackage(p.id);
  });

  it("list maps packages to SkillEntry (origin=idb, files, createdAt)", async () => {
    await putPackage(pkg("skill_user_x"));
    const [e] = await idbSkillSource.list();
    expect(e.id).toBe("skill_user_x");
    expect(e.name).toBe("Name skill_user_x");
    expect(e.origin).toBe("idb");
    expect(e.files.sort()).toEqual(["SKILL.md", "references/a.md"]);
    expect(e.createdAt).toBe(42);
  });

  it("readFile returns content / null", async () => {
    await putPackage(pkg("skill_user_x"));
    expect(await idbSkillSource.readFile("skill_user_x", "references/a.md")).toBe("ref");
    expect(await idbSkillSource.readFile("skill_user_x", "nope")).toBeNull();
  });

  it("write upserts a package parsed from SKILL.md; delete removes", async () => {
    await idbSkillSource.write("skill_user_w", [
      { path: "SKILL.md", content: "---\nname: W\ndescription: wd\n---\nbody" },
    ]);
    const [e] = await idbSkillSource.list();
    expect(e.name).toBe("W");
    expect(await idbSkillSource.delete("skill_user_w")).toBe(true);
    expect(await idbSkillSource.list()).toEqual([]);
    expect(await idbSkillSource.delete("skill_user_w")).toBe(false);
  });
});

describe("withBuiltins", () => {
  const fakeBackend = (entries: SkillEntry[]): SkillSource => ({
    mode: "idb",
    list: async () => entries,
    readFile: async () => null,
    write: async () => {},
    delete: async () => false,
  });

  it("merges builtin entries; backend wins on same id", async () => {
    const someBuiltinId = BUILT_IN_SKILL_PACKAGES[0].id;
    const override: SkillEntry = {
      id: someBuiltinId, name: "override", description: "o", builtIn: false,
      origin: "idb", files: ["SKILL.md"], runnableScripts: [],
    };
    const merged = await withBuiltins(fakeBackend([override])).list();
    expect(merged.filter((e) => e.id === someBuiltinId)).toHaveLength(1);
    expect(merged.find((e) => e.id === someBuiltinId)?.name).toBe("override");
    // 其余 builtin 全在
    expect(merged.filter((e) => e.origin === "builtin")).toHaveLength(BUILT_IN_SKILL_PACKAGES.length - 1);
  });

  it("readFile falls back to builtin files when backend misses", async () => {
    const someBuiltin = BUILT_IN_SKILL_PACKAGES[0];
    const src = withBuiltins(fakeBackend([]));
    const md = await src.readFile(someBuiltin.id, "SKILL.md");
    expect(md).toBe(someBuiltin.files["SKILL.md"]);
  });
});

describe("filterEnabled", () => {
  const entry = (id: string, origin: SkillEntry["origin"], builtIn = false): SkillEntry => ({
    id, name: id, description: "", builtIn, origin, files: [], runnableScripts: [],
  });
  it("disk + builtin default on; idb default off; markers override both ways", () => {
    const entries = [
      entry("b", "builtin", true), entry("d", "disk"), entry("u", "idb"),
      entry("d2", "disk"), entry("u2", "idb"),
    ];
    const on = filterEnabled(entries, ["!d2", "u2"]).map((e) => e.id).sort();
    expect(on).toEqual(["b", "d", "u2"]);
  });
});

describe("helpers", () => {
  it("stripFrontmatter removes fence, keeps body; passthrough without fence", () => {
    expect(stripFrontmatter("---\nname: x\n---\nBODY")).toBe("BODY");
    expect(stripFrontmatter("no fence")).toBe("no fence");
  });
  it("kebabSlug produces daemon-safe names", () => {
    expect(kebabSlug("Web Fetch 2")).toBe("web-fetch-2");
    expect(kebabSlug("  --Weird__name!  ")).toBe("weird-name");
    expect(kebabSlug("中文名")).toBe("");
  });
});
```

- [ ] **Step 2: 跑测确认失败** — `pnpm test -- src/lib/skills/source.test.ts` → FAIL。

- [ ] **Step 3: 实现 `source.ts`**

```ts
// src/lib/skills/source.ts
//
// Skill 真源抽象（spec docs/specs/2026-07-10-skill-system-with-local-daemon.md §4.5）。
// IdbSkillSource = 现状 IDB 后端；DaemonSkillSource（磁盘后端）在 src/background/
// daemon-skill-source.ts（依赖桥，panel 不可 import）。builtin 是只读层，
// 由 withBuiltins 在任一后端上并入。
import type { SkillPackage } from "./package-types";
import { listPackages, getPackage, putPackage, deletePackage } from "./skill-store";
import { BUILT_IN_SKILL_PACKAGES } from "./builtin";
import { parseSkillMarkdown } from "./frontmatter";
import { parseScriptDecls } from "./script-decl";

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  origin: "builtin" | "idb" | "disk";
  files: string[];
  runnableScripts: string[];
  createdAt?: number;
  author?: string;
}

export interface SkillWriteFile {
  path: string;
  content: string;
}

export interface SkillSource {
  mode: "idb" | "disk";
  list(): Promise<SkillEntry[]>;
  readFile(id: string, path: string): Promise<string | null>;
  write(id: string, files: SkillWriteFile[]): Promise<void>;
  delete(id: string): Promise<boolean>;
}

function pkgToEntry(p: SkillPackage, origin: "builtin" | "idb"): SkillEntry {
  return {
    id: p.id,
    name: p.frontmatter.name,
    description: p.frontmatter.description,
    builtIn: p.builtIn,
    origin,
    files: Object.keys(p.files),
    runnableScripts: parseScriptDecls(p.frontmatter.capabilities?.scripts).map((d) => d.entry),
    createdAt: p.createdAt,
    author: typeof p.frontmatter.author === "string" ? p.frontmatter.author : undefined,
  };
}

export const idbSkillSource: SkillSource = {
  mode: "idb",
  async list() {
    return (await listPackages()).map((p) => pkgToEntry(p, "idb"));
  },
  async readFile(id, path) {
    const pkg = await getPackage(id);
    return pkg?.files[path] ?? null;
  },
  async write(id, files) {
    const existing = await getPackage(id);
    const fileMap: Record<string, string> = { ...(existing?.files ?? {}) };
    for (const f of files) fileMap[f.path] = f.content;
    const md = fileMap["SKILL.md"];
    if (typeof md !== "string") throw new Error("write requires SKILL.md");
    const { frontmatter } = parseSkillMarkdown(md);
    await putPackage({
      id,
      frontmatter,
      files: fileMap,
      builtIn: false,
      createdAt: existing?.createdAt ?? Date.now(),
    });
  },
  async delete(id) {
    const existing = await getPackage(id);
    if (!existing) return false;
    await deletePackage(id);
    return true;
  },
};

const BUILTIN_ENTRIES: SkillEntry[] = BUILT_IN_SKILL_PACKAGES.map((p) => pkgToEntry(p, "builtin"));
const BUILTIN_BY_ID = new Map(BUILT_IN_SKILL_PACKAGES.map((p) => [p.id, p]));

/** builtin 只读层：任一后端上并入 builtin；后端同 id 覆盖 builtin（IDB 现状语义）。 */
export function withBuiltins(backend: SkillSource): SkillSource {
  return {
    mode: backend.mode,
    async list() {
      const user = await backend.list();
      const userIds = new Set(user.map((e) => e.id));
      return [...BUILTIN_ENTRIES.filter((b) => !userIds.has(b.id)), ...user];
    },
    async readFile(id, path) {
      const fromBackend = await backend.readFile(id, path);
      if (fromBackend !== null) return fromBackend;
      return BUILTIN_BY_ID.get(id)?.files[path] ?? null;
    },
    write: (id, files) => backend.write(id, files),
    delete: (id) => backend.delete(id),
  };
}

const BUILT_IN_IDS = new Set(BUILT_IN_SKILL_PACKAGES.map((b) => b.id));

/** enabled marker 语义（storage.ts）："!id"=关、"id"=开、无 marker 走默认。
 *  默认开 = builtin 或磁盘 skill（放上盘=意图，对齐 Claude Code）；IDB 用户 skill 默认关。 */
export function filterEnabled(entries: SkillEntry[], markers: string[]): SkillEntry[] {
  const on = new Set(markers.filter((m) => !m.startsWith("!")));
  const off = new Set(markers.filter((m) => m.startsWith("!")).map((m) => m.slice(1)));
  return entries.filter((e) => {
    if (off.has(e.id)) return false;
    if (on.has(e.id)) return true;
    return e.builtIn || BUILT_IN_IDS.has(e.id) || e.origin === "disk";
  });
}

const FENCE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** 剥 frontmatter 拿正文；不校验字段（磁盘 SKILL.md 是标准 frontmatter，
 *  extension 的 parseSkillMarkdown 不认连字符 key——正文提取只需 fence）。 */
export function stripFrontmatter(md: string): string {
  const m = md.match(FENCE);
  return m ? md.slice(m[0].length) : md;
}

/** 磁盘目录名 slug：小写、非字母数字折叠成 -、去首尾 -。结果空 = 名字无 ASCII 字母数字。 */
export function kebabSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

- [ ] **Step 4: 跑测确认通过** — `pnpm test -- src/lib/skills/source.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/source.ts src/lib/skills/source.test.ts
git commit -m "feat(skills): SkillSource abstraction — IdbSkillSource + builtin layer + enabled filter"
```

---

### Task 4: `DaemonSkillSource` + resolver + `getEnabledSkillEntries`

**Files:**
- Create: `src/background/daemon-skill-source.ts`
- Create: `src/background/skill-source.ts`
- Test: `src/background/daemon-skill-source.test.ts`、`src/background/skill-source.test.ts`

**Interfaces:**
- Consumes: Task 2 桥客户端；Task 3 `SkillSource`/`withBuiltins`/`filterEnabled`；`storage.ts` `getEnabledSkillIds`。
- Produces:
  ```ts
  // daemon-skill-source.ts
  export const daemonSkillSource: SkillSource;   // mode:"disk"
  // skill-source.ts
  export function getActiveSkillSource(): SkillSource;              // withBuiltins(bridgeHasSkillFs() ? daemon : idb)
  export async function getEnabledSkillEntries(): Promise<SkillEntry[]>;  // await bridgeSettled() → list → filterEnabled
  ```
- `daemonSkillSource` 映射：`list()` → `requestListSkills().skills.map(s => ({ id: s.name, name: s.name, description: s.description, builtIn: false, origin: "disk", files: s.files, runnableScripts: s.runnableScripts }))`；`readFile` → `requestReadSkillFile`（daemon 抛错 → 返回 `null`，与 IDB 语义一致）；`write` → `requestWriteSkill`；`delete` → `requestDeleteSkill(...).deleted`。

- [ ] **Step 1: 写失败测试**

`daemon-skill-source.test.ts`：vi.mock `./local-bridge`，断言四方法的参数映射与 SkillEntry 形状（origin="disk"、id=name、readFile 抛错→null）。
`skill-source.test.ts`：vi.mock `./local-bridge`（`bridgeHasSkillFs` 可控 + `bridgeSettled` resolved）与 fake IDB：
- `bridgeHasSkillFs()=false` → `getActiveSkillSource().mode === "idb"`，list 含 builtin 条目。
- `bridgeHasSkillFs()=true` → mode `"disk"`，list = builtin + mocked daemon 条目。
- `getEnabledSkillEntries()`：mocked daemon 条目默认在（disk 默认开），`!`-marker 能关掉。

- [ ] **Step 2: 跑测确认失败**。

- [ ] **Step 3: 实现**

```ts
// src/background/daemon-skill-source.ts
import type { SkillSource } from "@/lib/skills/source";
import {
  requestListSkills, requestReadSkillFile, requestWriteSkill, requestDeleteSkill,
} from "./local-bridge";

/** 磁盘后端：全部经桥问 daemon（~/.pie/skills 为真源，扩展零缓存）。 */
export const daemonSkillSource: SkillSource = {
  mode: "disk",
  async list() {
    const { skills } = await requestListSkills();
    return skills.map((s) => ({
      id: s.name,
      name: s.name,
      description: s.description,
      builtIn: false,
      origin: "disk" as const,
      files: s.files,
      runnableScripts: s.runnableScripts,
    }));
  },
  async readFile(id, path) {
    try {
      return (await requestReadSkillFile({ name: id, path })).content;
    } catch {
      return null; // 缺文件/坏名 → null，与 IDB 后端语义一致
    }
  },
  async write(id, files) {
    await requestWriteSkill({ name: id, files });
  },
  async delete(id) {
    return (await requestDeleteSkill({ name: id })).deleted;
  },
};
```

```ts
// src/background/skill-source.ts
import { withBuiltins, filterEnabled, idbSkillSource, type SkillEntry, type SkillSource } from "@/lib/skills/source";
import { getEnabledSkillIds } from "@/lib/skills/storage";
import { bridgeHasSkillFs, bridgeSettled } from "./local-bridge";
import { daemonSkillSource } from "./daemon-skill-source";

/** 模式判定唯一入口：daemon 连着且声明 skill_fs → 磁盘真源，否则 IDB。 */
export function getActiveSkillSource(): SkillSource {
  return withBuiltins(bridgeHasSkillFs() ? daemonSkillSource : idbSkillSource);
}

/** loop/task-seed 用：桥落定后取 enabled 条目（防 SW 冷启动握手竞态掉回 IDB 模式）。 */
export async function getEnabledSkillEntries(): Promise<SkillEntry[]> {
  await bridgeSettled();
  const [entries, markers] = await Promise.all([getActiveSkillSource().list(), getEnabledSkillIds()]);
  return filterEnabled(entries, markers);
}
```

- [ ] **Step 4: 跑测确认通过**。

- [ ] **Step 5: Commit**

```bash
git add src/background/daemon-skill-source.ts src/background/skill-source.ts src/background/daemon-skill-source.test.ts src/background/skill-source.test.ts
git commit -m "feat(sw): DaemonSkillSource + active-source resolver (skill_fs capability gate)"
```

---

### Task 5: use_skill / read_skill_file / loop catalog 走 source

**Files:**
- Modify: `src/lib/agent/tools/skill-access.ts`
- Modify: `src/lib/agent/loop.ts`（catalog 取数两处，`grep -n getEnabledSkillPackages` 定位）
- Test: skill-access 现有测试文件（`grep -rl "use_skill" src --include="*.test.ts"` 定位）改造 + 新增磁盘模式用例

**Interfaces:**
- Consumes: `getActiveSkillSource`（Task 4）、`stripFrontmatter`（Task 3）。
- Produces: 工具行为——`use_skill`：merged list 找 entry → `readFile(id,"SKILL.md")` → `stripFrontmatter` 正文 + refNote（`entry.files` 去 `SKILL.md`）+ scriptNote（`entry.runnableScripts`）；`read_skill_file`：`readFile` null → error。**为可测性把 source 做成可注入 deps**（镜像 `buildRunSkillScriptTool` 模式）。

- [ ] **Step 1: 改造为工厂 + 写失败测试**

`skill-access.ts` 重构为：

```ts
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { SkillSource } from "../../skills/source";
import { stripFrontmatter } from "../../skills/source";
import { getActiveSkillSource } from "@/background/skill-source";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";

function wrap(content: string): string {
  return `<untrusted_skill_content>${escapeUntrustedWrappers(content)}</untrusted_skill_content>`;
}

export interface SkillAccessDeps {
  getSource: () => SkillSource;
}

export function buildSkillAccessTools(deps: SkillAccessDeps): Tool[] {
  return [
    {
      name: "use_skill",
      description: /* 原文保持 */,
      parameters: /* 原 schema 保持 */,
      handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
        const { skillId } = (args ?? {}) as { skillId?: string };
        if (!skillId) return { success: false, error: "use_skill requires skillId" };
        const source = deps.getSource();
        const entry = (await source.list()).find((e) => e.id === skillId);
        if (!entry) return { success: false, error: `Unknown skill: ${skillId}` };
        const md = await source.readFile(skillId, "SKILL.md");
        if (md === null) return { success: false, error: `Skill has no SKILL.md: ${skillId}` };
        const body = stripFrontmatter(md);
        const refs = entry.files.filter((p) => p !== "SKILL.md");
        const refNote = refs.length
          ? `\n\nAdditional files available via read_skill_file: ${refs.join(", ")}`
          : "";
        const scriptNote = entry.runnableScripts.length
          ? `\n\nBundled scripts runnable via run_skill_script: ${entry.runnableScripts.join(", ")}`
          : "";
        return { success: true, observation: wrap(body + refNote + scriptNote) };
      },
    },
    {
      name: "read_skill_file",
      description: /* 原文保持 */,
      parameters: /* 原 schema 保持 */,
      handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
        const { skillId, path } = (args ?? {}) as { skillId?: string; path?: string };
        if (!skillId || !path)
          return { success: false, error: "read_skill_file requires skillId and path" };
        const content = await deps.getSource().readFile(skillId, path);
        if (content === null)
          return { success: false, error: `No such file: ${skillId}/${path}` };
        return { success: true, observation: wrap(content) };
      },
    },
  ];
}

export const SKILL_ACCESS_TOOLS: Tool[] = buildSkillAccessTools({ getSource: getActiveSkillSource });
```

测试：fake source（内存 entries+files）注入，覆盖——IDB 形与磁盘形 entry 的 use_skill 输出（正文剥 frontmatter、refNote、scriptNote）、unknown skill、read_skill_file null→error、`<untrusted_skill_content>` 包裹。**磁盘形 SKILL.md 用带 `allowed-tools`/`metadata.pie` 嵌套的标准 frontmatter fixture**，断言正文照剥（旧 parseSkillMarkdown 会 throw 的输入现在要过）。

- [ ] **Step 2: 跑测确认失败**。

- [ ] **Step 3: 实现 + loop.ts 换取数**

loop.ts（`getEnabledSkillPackages` 两处调用点，行号用 grep 现查）：

```ts
// import 换：
import { getEnabledSkillEntries } from "@/background/skill-source";
// 调用点换（原 enabledPkgs.map(p => ({ id: p.id, name: p.frontmatter.name, description: p.frontmatter.description }))）：
const enabledEntries = await getEnabledSkillEntries();
const skillCatalog = enabledEntries.map((e) => ({ id: e.id, name: e.name, description: e.description }));
```

第二处（loop 内重建 catalog 的 `hasSkills` 引用）同形替换。

- [ ] **Step 4: 全量门禁** — `pnpm test`（skill-access + loop 相关全绿）+ `pnpm typecheck`。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools/skill-access.ts src/lib/agent/loop.ts <测试文件>
git commit -m "feat(agent): use_skill/read_skill_file/catalog resolve through active SkillSource"
```

---

### Task 6: skill-meta CRUD 双模式

**Files:**
- Modify: `src/lib/agent/tools/skill-meta.ts`
- Test: skill-meta 现有测试（grep 定位）+ 磁盘模式新用例

**Interfaces:**
- Consumes: `getActiveSkillSource`、`kebabSlug`、`stripFrontmatter`（Task 3/4）；现有 `buildSkillMd`/`isSingleLineSafe`/quota helpers。
- Produces: 4 工具双模式行为（下详）。**source 注入 deps**（`buildSkillMetaTools(deps)` 工厂，默认实例绑 `getActiveSkillSource`）。

**行为规格：**
- `list_skills`：`source.list()`（merged）→ summary（id/name/description/author/builtIn 保持，author 磁盘条目缺省 `"user"`）。
- `create_skill`：
  - 共同守卫不变：name/description/instructions 非空、single-line、8KB cap（P0-D）。
  - IDB 模式：现状逐字保留（generateSkillId、quota P1-H、putPackage、setSkillEnabled(id,true)）。
  - 磁盘模式：`id = kebabSlug(name)`；slug 为空 → `id = "skill-" + crypto.randomUUID().slice(0, 8)`；merged list 已有该 id → error `skill name already exists: <id>`；`source.write(id, [{path:"SKILL.md", content: buildSkillMd(...)}])`；**无 quota**（磁盘无 1MB 语义）；无需 setSkillEnabled（disk 默认开）。observation 同现状格式。
  - **已知简化**：磁盘模式落盘的 SKILL.md 沿用 `buildSkillMd` 现有输出（顶层 `author:` 字段，非 spec §4.2 的 `metadata.author`）——daemon `parseSkillMd` 只取 name/description/metadata.pie，多余顶层字段无害；标准化 authoring 输出留 follow-up，不在本 slice 阻塞。
- `update_skill`：
  - entry 查 merged list；`entry.builtIn` → P0-A error 不变。
  - 现 SKILL.md 经 `source.readFile` 取、`stripFrontmatter` 拿 body（替换现 parseSkillMarkdown+fallback 逻辑——两模式统一，IDB 自产 SKILL.md 剥 fence 结果与原 body 一致）。
  - patch 字段/守卫/P0-C taint（author=agent）不变；重建 md 后 `source.write(id, [SKILL.md])`。
  - quota 检查仅 IDB 模式跑。
  - **磁盘模式改 name 不改目录名**（id=目录不动，frontmatter.name 变）——observation 附一句 `note: on-disk directory name (id) is unchanged`。
- `delete_skill`：entry 查 merged list；builtIn 守卫不变；`source.delete(id)` + `setSkillEnabled(id,false)`（清 marker，磁盘模式同样调——防 stale plain-marker 留存）。

- [ ] **Step 1: 写失败测试** — fake source 注入：磁盘 create（slug id / 撞名 error / 空 slug 随机 id / 不跑 quota）、磁盘 update（builtin 守卫、body 替换、write 只带 SKILL.md）、delete 双模式、list 形状；IDB 模式现有用例全部零改动通过（工厂默认路径兼容）。
- [ ] **Step 2: 跑测确认失败**。
- [ ] **Step 3: 实现**（`SKILL_META_TOOLS` 导出保持 = `buildSkillMetaTools({ getSource: getActiveSkillSource })`，`SKILL_META_TOOL_NAMES`/`isSkillMetaToolName` 不动）。
- [ ] **Step 4: 跑测确认通过 + `pnpm typecheck`**。
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): skill CRUD meta tools go dual-mode through SkillSource"`

---

### Task 7: run_skill_script 磁盘分支

**Files:**
- Modify: `src/lib/agent/tools/skill-script.ts`
- Test: `src/lib/agent/tools/skill-script.test.ts`（grep 确认实际文件名）

**Interfaces:**
- Consumes: `getActiveSkillSource`（entry.origin 判路由）、`requestRunSkillScript`（Task 2）。
- Produces: 工具 schema 加可选 `args`：
  ```ts
  args: { type: "array", items: { type: "string" }, description: "CLI-style string arguments for privileged (daemon-run) scripts." },
  ```
  deps 扩展：
  ```ts
  export interface SkillScriptDeps {
    runInSandbox: (code: string, input: unknown) => Promise<string>;
    getSource: () => SkillSource;
    runOnDaemon: (p: { name: string; entry: string; args?: string[] }) => Promise<RunSkillScriptOutcome>;
  }
  ```

**行为规格（handler 顺序）：**
1. 参数校验现状。
2. `entry = (await deps.getSource().list()).find(e => e.id === skillId)`；缺 → `Unknown skill` 现状文案。
3. **`entry.origin === "disk"`** → 磁盘路径：
   - `a.entry ∈ entry.runnableScripts`？否 → error `Script not declared by skill ...`（复用现声明门禁文案形式，declared 列表 = runnableScripts）。
   - `argv = a.args ?? (a.input !== undefined ? [JSON.stringify(a.input)] : [])`。
   - `outcome = await deps.runOnDaemon({ name: skillId, entry: a.entry, args: argv })`：
     - `ok` → `observation: wrap(outcome.result.output)`（`<untrusted_skill_content>`；`truncated` 时文末附 ` [output truncated]`）。
     - `needsAuth` → `error: "authorization_required: this skill needs your approval to run scripts on this machine. The authorization card UI ships in the next update — for now the user can pre-authorize via daemon tooling."`
     - 其余 → `error: run_skill_script failed: <message>`。
4. 否则（builtin/idb）→ 现状 2a 路径逐字保留（声明门禁、纯计算判定、privileged_script error、offscreen sandbox）。

- [ ] **Step 1: 写失败测试** — fake deps：磁盘 entry 路由到 runOnDaemon（args 透传 / input 序列化成单参）、未声明 entry 拒、needsAuth error 文案、stdout 包 wrapper、truncated 后缀；IDB/builtin 现有用例零改动。
- [ ] **Step 2: 跑测确认失败**。
- [ ] **Step 3: 实现**（默认实例 `RUN_SKILL_SCRIPT_TOOL = buildRunSkillScriptTool({ runInSandbox: <现状>, getSource: getActiveSkillSource, runOnDaemon: requestRunSkillScript })`）。
- [ ] **Step 4: 跑测确认通过 + typecheck**。
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): run_skill_script routes disk skills to daemon (srt path); needs_authorization surfaced"`

---

### Task 8: panel RPC 通道（skills-action）

**Files:**
- Create: `src/lib/skills/panel-actions.ts`
- Create: `src/background/skills-action-handler.ts`
- Modify: `src/background/index.ts`（onMessage 分支，镜像 `SCHEDULE_ACTION_MESSAGE` 段）
- Test: `src/background/skills-action-handler.test.ts`

**Interfaces:**
- Produces（panel 侧 API，Task 9 消费）：
  ```ts
  // src/lib/skills/panel-actions.ts —— 镜像 src/lib/schedules/panel-actions.ts 模式
  export const SKILLS_ACTION_MESSAGE = "skills-action" as const;
  export interface SkillsActionMessage {
    type: typeof SKILLS_ACTION_MESSAGE;
    action: "list" | "read-file" | "write" | "delete";
    payload?: unknown;
  }
  export type SkillsListResponse = { ok: true; skills: SkillEntry[] } | { ok: false; error: string };
  export type SkillsReadFileResponse = { ok: true; content: string | null } | { ok: false; error: string };
  export type SkillsWriteResponse = { ok: true } | { ok: false; error: string };
  export type SkillsDeleteResponse = { ok: true; deleted: boolean } | { ok: false; error: string };
  export function listSkillEntries(): Promise<SkillsListResponse>;                      // action:"list"
  export function readSkillFileRpc(id: string, path: string): Promise<SkillsReadFileResponse>;
  export function writeSkillRpc(id: string, files: SkillWriteFile[]): Promise<SkillsWriteResponse>;
  export function deleteSkillRpc(id: string): Promise<SkillsDeleteResponse>;
  ```
  实现全部薄包 `swPort.request({ type: SKILLS_ACTION_MESSAGE, action, payload })`。
- SW handler：
  ```ts
  // src/background/skills-action-handler.ts
  export async function handleSkillsAction(m: SkillsActionMessage): Promise<...对应 Response>;
  ```
  每 action：`await bridgeSettled()` → `getActiveSkillSource()` → 执行 → `{ok:true,...}`；异常 → `{ok:false,error}`。**list 返回 merged 全量（不过滤 enabled）**——SkillsList 要显示禁用项，Chat slash 自己用 `filterEnabled`（markers panel 直读 IDB config）。
- `background/index.ts` onMessage（schedule 分支旁）：
  ```ts
  if (message?.type === SKILLS_ACTION_MESSAGE) {
    const m = message as SkillsActionMessage;
    handleSkillsAction(m)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  ```

- [ ] **Step 1: 写失败测试** — handler 单测：mock `skill-source`（fake active source）+ `bridgeSettled` resolved，覆盖 4 action 的成功/异常包形。
- [ ] **Step 2: 跑测确认失败**。
- [ ] **Step 3: 实现三文件**。
- [ ] **Step 4: 跑测确认通过 + typecheck**。
- [ ] **Step 5: Commit** — `git commit -m "feat(panel-rpc): skills-action channel — panel reads skills through SW active source"`

---

### Task 9: Chat slash + SkillsList 走 RPC

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（slash 数据源）
- Modify: `src/sidepanel/components/SkillsList.tsx`
- Modify: `src/lib/skills/slash.ts` + `src/sidepanel/components/SkillSlashPopover.tsx`（签名从 SkillPackage 改 SkillEntry，如实际引用）
- Test: 相关现有组件/单测适配（grep `getEnabledSkillPackages`、`getAllSkillPackages` 的测试引用点）

**行为规格：**
- **Chat slash**：`getEnabledSkillPackages()` 调用换 `listSkillEntries()`（RPC）+ `getEnabledSkillIds()`（直读）→ `filterEnabled`。`filterAndSortSkillsForSlash` 与 slash.ts 的匹配函数改吃 `SkillEntry`（`frontmatter.name` → `.name`；`createdAt ?? 0` 排序）。RPC 失败 → 空列表（slash popover 不出，静默降级，console.warn）。
- **SkillsList**：
  - 列表加载：`getAllSkillPackages()+getEnabledSkillIds()` → `listSkillEntries()+getEnabledSkillIds()`；enabled 显示态用与 `filterEnabled` 同一套判定（default-on 集合扩进 `origin==="disk"`）。
  - toggle：`setSkillEnabled(id, ...)` 现状不动（enabled 是扩展侧 pref）。
  - 编辑：读 body 用 `readSkillFileRpc(id, "SKILL.md")` + `stripFrontmatter`；保存 `writeSkillRpc(id, [{path:"SKILL.md",content}])`（SKILL.md 由现有 buildSkillMd 构建逻辑生成，保持现状守卫）。
  - 删除：`deleteSkillRpc(id)` + `setSkillEnabled(id,false)`。
  - builtin 项只读守卫现状（entry.builtIn）。
- **不加新文案**：loading/error 态复用组件现有模式。

- [ ] **Step 1: 适配测试**（现有 SkillsList/Chat 相关测试 mock 改为 panel-actions mock；新增：SkillsList 渲染 disk 条目 default-on、edit 走 RPC 读写）。
- [ ] **Step 2: 跑测确认失败**。
- [ ] **Step 3: 实现改造**。
- [ ] **Step 4: `pnpm test` 全量 + typecheck**（Chat.tsx 改动面广，全量跑）。
- [ ] **Step 5: Commit** — `git commit -m "feat(panel): Chat slash + SkillsList read skills via skills-action RPC (single path, both modes)"`

---

### Task 10: IDB→磁盘迁移（首次进磁盘模式，幂等）

**Files:**
- Create: `src/background/skill-migration.ts`
- Modify: `src/background/index.ts`（SW 启动：`maybeInitLocalBridge()` 之后挂 `void migrateIdbSkillsToDisk()`）
- Test: `src/background/skill-migration.test.ts`

**Interfaces:**
- Consumes: `bridgeHasSkillFs`/`bridgeSettled`/`requestListSkills`/`requestWriteSkill`（Task 2）、`listPackages`（skill-store）、`kebabSlug`（Task 3）、`getEnabledSkillIds`/`setSkillEnabled`（storage）。
- Produces:
  ```ts
  export async function migrateIdbSkillsToDisk(): Promise<{ migrated: string[]; skipped: string[] }>;
  ```

**行为规格：**
1. `await bridgeSettled()`；`!bridgeHasSkillFs()` → 立即返回空结果（纯 BYOK 零成本）。
2. `userPkgs = (await listPackages()).filter(p => !p.builtIn)`；空 → 返回。
3. `existing = new Set((await requestListSkills()).skills.map(s => s.name))`。
4. 逐 pkg：`slug = kebabSlug(pkg.frontmatter.name)`；slug 空 → skipped（console.warn 提示改名后手动迁，**不造随机名**——迁移要可预期）；`existing.has(slug)` → skipped（幂等：已在盘=已迁过或用户自建，绝不覆盖）；否则 `requestWriteSkill({ name: slug, files: Object.entries(pkg.files).map(([path, content]) => ({ path, content })) })` → migrated，`existing.add(slug)`。
5. enabled 继承：旧 marker 含 `!${pkg.id}`（显式关）→ `setSkillEnabled(slug, false)`；其余不动（disk 默认开）。
6. IDB 原件**保留**（daemon-关 回退用；磁盘模式不再读）。
7. 全程 try/catch 包单个 pkg（一个坏包不拖垮整体），整体异常 console.warn 不抛（启动路径绝不能挂 SW）。

- [ ] **Step 1: 写失败测试** — mock 桥模块 + fake-indexeddb：无 skill_fs 零动作；正常迁移（files 铺开、slug 化）；同名已在盘跳过（二跑幂等 = migrated 空）；显式关 marker 继承；空 slug 跳过；单包失败不影响其余。
- [ ] **Step 2: 跑测确认失败**。
- [ ] **Step 3: 实现 + index.ts 启动挂钩**（`void migrateIdbSkillsToDisk()` fire-and-forget，紧跟 `maybeInitLocalBridge()` 之后——内部自 await bridgeSettled，不阻塞 SW 启动别的初始化）。
- [ ] **Step 4: 跑测确认通过 + 三门禁全量** — `pnpm test` / `pnpm typecheck` / `pnpm build`。
- [ ] **Step 5: Commit** — `git commit -m "feat(sw): one-shot idempotent IDB→disk skill migration on first skill_fs session"`

---

## 真机验证清单（Slice 2 完成后，人工）

1. daemon 关：一切现状（catalog/slash/SkillsList/2a 纯计算脚本）零回归。
2. daemon 开（热替换二进制先 `rm` 再 `cp`）：`~/.pie/skills/hello/`（SKILL.md + scripts/run.ts）→ 侧栏 SkillsList 出现、默认启用；catalog 进 system prompt；`use_skill` 返回正文；`read_skill_file` 读 references。
3. 磁盘模式改 `~/.pie/skills/hello/SKILL.md` → 再次 use_skill 立即见新内容（**双真源 bug 死亡确认**：无 IDB 缓存）。
4. `run_skill_script` 磁盘 skill → 返回 authorization_required 错误（Slice 3 前的预期行为）；手动预授权（socket 客户端带 grantApproved）后可跑通、stdout 回对话。
5. IDB 里既有用户 skill：首次连 daemon 自动迁到 `~/.pie/skills/<slug>/`；再断开 daemon → IDB 回退模式还能看到原件；重连不重复迁。
6. create_skill（LLM 侧）在磁盘模式落盘为标准目录；SkillsList 编辑/删除直接操作磁盘。
7. slash popover 两模式列表一致性（磁盘模式列磁盘+builtin）。

## Slice 2 完成判据

- `pnpm test` / `pnpm typecheck`（0 错）/ `pnpm build` 全过；`cd daemon && bun test` 全绿。
- 真机清单 1-7 过。
- 双真源 bug 结构性消灭：磁盘模式下扩展对 skill 内容零持久缓存。
- Slice 3（授权卡 + grants 设置页）的桥客户端（list_grants/revoke_grant/needsAuth outcome）已就绪。
