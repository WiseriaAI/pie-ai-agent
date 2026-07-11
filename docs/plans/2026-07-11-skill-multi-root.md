# Skill 多根目录（~/.agents/skills 只读副根）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** daemon 在主根 `~/.pie/skills`（读写）之外挂载只读副根 `~/.agents/skills`，合并为单一 skill 视图；扩展侧获得 `source` 标识、只读行、首连导入向导。

**Architecture:** 合并在 daemon skill-store 层（方案 A）：新原语 `resolveSkillRoot` + `listSkillsMerged` + `deleteSkillGuarded`，dispatcher 三个 case 换调用；wire 给 `SkillSummary` 加 optional `source`；扩展侧 `SkillEntry.source` 透传，`filterEnabled` 给副根加默认关条件，SkillsList 加只读行与导入向导。安全脊柱（grants/srt/audit/safeRelPath）零改动。

**Tech Stack:** Bun（daemon + bun:test）、TypeScript、React 19 + vitest + happy-dom + @testing-library/react、IDB config store。

**Spec:** `docs/specs/2026-07-11-skill-multi-root.md`（已合 main d2656561；本 plan Task 1 含两处勘误，见下）

## Global Constraints

- wire 改动**只加法**，`PROTOCOL_VERSION = 1` 不动（`src/types/local-bridge.ts` 是唯一权威源，daemon 相对 import）
- `~/.agents/skills` 下**既有文件永不被写/删**；唯一例外是脚本执行时在 skill 目录内创建 `workspace/` 运行产物目录（与主根行为一致；`workspace`/`.runs` 本就被 `packageFiles`/`runnableScripts` 排除）
- 安全零改动：信封授权（grants）、srt 沙箱设置、audit、`safeRelPath`（目录级 symlink 跟随、文件级拒）全部不动
- i18n 六字典（en / zh-CN / zh-TW / ja / es-419 / pt-BR）键 parity，typecheck 强制——**加 key 必须六份一起加**
- daemon 测试的临时目录一律 `mkdtempSync(join(tmpdir(), ...))`；**测试 fixture 绝不能让默认副根（真实 `~/.agents/skills`）漏进来**——凡不显式传 roots/skillsRoot 的路径都会读真机目录
- 每个 task 收尾跑该 task 的覆盖测试；分支收尾跑 `pnpm test`、`pnpm typecheck`、`pnpm build` 与 `cd daemon && bun test` 全绿
- 提交信息遵循仓库现有风格（`feat(daemon): ...` / `feat(panel): ...` / `docs: ...`）

---

### Task 1: wire 类型加法 + spec 勘误

**Files:**
- Modify: `src/types/local-bridge.ts:75-86`（SkillSummary）
- Modify: `docs/specs/2026-07-11-skill-multi-root.md`（§6 一句勘误 + §4 一句补充）

**Interfaces:**
- Produces: `SkillSummary.source?: "pie" | "agents"`（Task 2/5 依赖）

- [ ] **Step 1: SkillSummary 加 source 字段**

在 `src/types/local-bridge.ts` 的 `SkillSummary` interface（`files: string[];` 之后）加：

```ts
  /** 来源根：主根 ~/.pie/skills = "pie"，只读副根 ~/.agents/skills = "agents"。
   *  optional 加法字段：旧 daemon 不给 → 扩展按 "pie" 处理（无 badge）。 */
  source?: "pie" | "agents";
```

- [ ] **Step 2: spec 勘误（两处）**

`docs/specs/2026-07-11-skill-multi-root.md` §6 中这句：

> `enabled_skills` 语义零改动：非内置默认关（`src/lib/skills/index.ts` 现有判定），勾选 = plain id 加入名单，手动关 = `!id`。

替换为：

> `enabled_skills` marker 语义（plain id=开、`!id`=关）零改动；**默认规则改一条**：daemon 模式的启用过滤在 `src/lib/skills/source.ts` 的 `filterEnabled`（非 `index.ts`——那是 IDB 路径），现行「磁盘 skill 默认开」收窄为仅主根（`source !== "agents"`）；副根 skill 无 marker 时默认关。

§4 skill-exec 小节末尾补一句：

> 副根 skill 执行时 `workspace/` 运行产物目录同样创建在该 skill 目录内（与主根一致）；这不修改任何既有文件，且 `workspace`/`.runs` 本就被 files 清单与可执行集排除。

- [ ] **Step 3: typecheck 验证 + 提交**

```bash
pnpm typecheck   # 期望 0 错
git add src/types/local-bridge.ts docs/specs/2026-07-11-skill-multi-root.md
git commit -m "feat(wire): SkillSummary.source 加法字段 + spec 勘误（filterEnabled 定位/副根 workspace 语义）"
```

---

### Task 2: daemon 多根原语（paths + resolveSkillRoot + listSkillsMerged + deleteSkillGuarded）

**Files:**
- Modify: `daemon/src/paths.ts`
- Modify: `daemon/src/skill-store.ts`（文件末尾追加，现有函数不动）
- Test: `daemon/test/skill-store-multiroot.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `listSkills(root)` / `deleteSkill(name, root)` / `assertSkillName`、Task 1 的 `SkillSummary.source`
- Produces（Task 3/4 依赖，签名照抄）:
  - `interface SkillRoots { primary: string; secondary?: string }`
  - `const defaultRoots: SkillRoots`
  - `resolveSkillRoot(name: string, roots?: SkillRoots): { root: string; source: "pie" | "agents" } | null`
  - `listSkillsMerged(roots?: SkillRoots): SkillSummary[]`
  - `deleteSkillGuarded(name: string, roots?: SkillRoots): boolean`（副根命中 → throw `{code:"read_only"}`）

- [ ] **Step 1: 写失败测试**

新建 `daemon/test/skill-store-multiroot.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listSkillsMerged, resolveSkillRoot, deleteSkillGuarded } from "../src/skill-store";

let primary: string;
let secondary: string;

function putSkill(root: string, name: string, description = "d"): void {
  const dir = join(root, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
  writeFileSync(join(dir, "scripts", "run.sh"), "echo ok");
}

beforeEach(() => {
  primary = mkdtempSync(join(tmpdir(), "pie-mr-p-"));
  secondary = mkdtempSync(join(tmpdir(), "pie-mr-s-"));
});
afterEach(() => {
  rmSync(primary, { recursive: true, force: true });
  rmSync(secondary, { recursive: true, force: true });
});

test("listSkillsMerged: 两根合并且带 source", () => {
  putSkill(primary, "alpha");
  putSkill(secondary, "beta");
  const skills = listSkillsMerged({ primary, secondary });
  expect(skills).toHaveLength(2);
  expect(skills.find((s) => s.name === "alpha")?.source).toBe("pie");
  expect(skills.find((s) => s.name === "beta")?.source).toBe("agents");
});

test("listSkillsMerged: 同名主根遮蔽副根", () => {
  putSkill(primary, "dup", "from-pie");
  putSkill(secondary, "dup", "from-agents");
  const skills = listSkillsMerged({ primary, secondary });
  expect(skills).toHaveLength(1);
  expect(skills[0].source).toBe("pie");
  expect(skills[0].description).toBe("from-pie");
});

test("listSkillsMerged: 副根缺失 → 只有主根", () => {
  putSkill(primary, "alpha");
  const skills = listSkillsMerged({ primary, secondary: join(secondary, "nope") });
  expect(skills).toHaveLength(1);
});

test("resolveSkillRoot: 主根优先 / 落副根 / 双无 null", () => {
  putSkill(primary, "dup");
  putSkill(secondary, "dup");
  putSkill(secondary, "only-agents");
  expect(resolveSkillRoot("dup", { primary, secondary })).toEqual({ root: primary, source: "pie" });
  expect(resolveSkillRoot("only-agents", { primary, secondary })).toEqual({ root: secondary, source: "agents" });
  expect(resolveSkillRoot("ghost", { primary, secondary })).toBeNull();
});

test("deleteSkillGuarded: 副根 skill 抛 read_only 且 message 含磁盘路径", () => {
  putSkill(secondary, "ro-skill");
  let err: unknown;
  try {
    deleteSkillGuarded("ro-skill", { primary, secondary });
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string }).code).toBe("read_only");
  expect(String(err)).toContain(join(secondary, "ro-skill"));
  expect(existsSync(join(secondary, "ro-skill", "SKILL.md"))).toBe(true); // 文件未动
});

test("deleteSkillGuarded: 删遮蔽副本后副根版本重新露出", () => {
  putSkill(primary, "dup", "from-pie");
  putSkill(secondary, "dup", "from-agents");
  expect(deleteSkillGuarded("dup", { primary, secondary })).toBe(true);
  const skills = listSkillsMerged({ primary, secondary });
  expect(skills).toHaveLength(1);
  expect(skills[0].source).toBe("agents");
  expect(skills[0].description).toBe("from-agents");
});

test("deleteSkillGuarded: 两根都无 → false", () => {
  expect(deleteSkillGuarded("ghost", { primary, secondary })).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd daemon && bun test test/skill-store-multiroot.test.ts
```
期望：FAIL —— `listSkillsMerged` 等导出不存在（import 报错）。

- [ ] **Step 3: 实现**

`daemon/src/paths.ts` 的 `paths` 对象加一行（`skillsDir` 之后）：

```ts
  agentsSkillsDir: join(homedir(), ".agents", "skills"),
```

`daemon/src/skill-store.ts` 文件末尾追加：

```ts
// ---- 多根（spec docs/specs/2026-07-11-skill-multi-root.md）----
// 主根 ~/.pie/skills 读写；副根 ~/.agents/skills 只读（跨 agent 通用目录）。
// 合并/遮蔽/只读判定全部收在这一层，listSkills/deleteSkill 保持单根原语。

export interface SkillRoots {
  primary: string;
  /** 只读副根；缺省 = 单根行为（测试传 {primary} 即隔离真实 ~/.agents） */
  secondary?: string;
}

export const defaultRoots: SkillRoots = {
  primary: paths.skillsDir,
  secondary: paths.agentsSkillsDir,
};

/** 主根优先定位 skill 所在根；SKILL.md 存在才算（与 listSkills 判据一致）。 */
export function resolveSkillRoot(
  name: string,
  roots: SkillRoots = defaultRoots,
): { root: string; source: "pie" | "agents" } | null {
  const n = assertSkillName(name);
  if (existsSync(join(roots.primary, n, "SKILL.md"))) return { root: roots.primary, source: "pie" };
  if (roots.secondary && existsSync(join(roots.secondary, n, "SKILL.md"))) {
    return { root: roots.secondary, source: "agents" };
  }
  return null;
}

/** 两根合并；同名主根遮蔽（被遮蔽的副根版本不出现）。 */
export function listSkillsMerged(roots: SkillRoots = defaultRoots): SkillSummary[] {
  const primary = listSkills(roots.primary).map((s) => ({ ...s, source: "pie" as const }));
  if (!roots.secondary) return primary;
  const shadowed = new Set(primary.map((s) => s.name));
  const secondary = listSkills(roots.secondary)
    .filter((s) => !shadowed.has(s.name))
    .map((s) => ({ ...s, source: "agents" as const }));
  return [...primary, ...secondary];
}

/** 删除 = 只删主根副本（CoW 的逆操作：删遮蔽副本 → 副根版本重新露出）。
 *  skill 只存在于副根 → read_only（message 带真身路径，告诉用户去哪删）。 */
export function deleteSkillGuarded(name: string, roots: SkillRoots = defaultRoots): boolean {
  const r = resolveSkillRoot(name, roots);
  if (r?.source === "agents") {
    throw Object.assign(
      new Error(`read-only skill (lives in ${join(r.root, assertSkillName(name))}); delete it there if intended`),
      { code: "read_only" },
    );
  }
  return deleteSkill(name, roots.primary);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd daemon && bun test test/skill-store-multiroot.test.ts   # 期望 7 pass
cd daemon && bun test                                       # 期望全绿（现有测试不回归）
```

- [ ] **Step 5: 提交**

```bash
git add daemon/src/paths.ts daemon/src/skill-store.ts daemon/test/skill-store-multiroot.test.ts
git commit -m "feat(daemon): skill 多根原语——resolveSkillRoot/listSkillsMerged/deleteSkillGuarded（主根遮蔽+副根 read_only）"
```

---

### Task 3: daemon dispatcher 接线（list_skills / read_skill_file / delete_skill）

**Files:**
- Modify: `daemon/src/daemon.ts`（三个 case 的调用处，结构不动）

**Interfaces:**
- Consumes: Task 2 的 `listSkillsMerged` / `resolveSkillRoot` / `deleteSkillGuarded`

- [ ] **Step 1: 改三个 case**

`daemon/src/daemon.ts`（skills 相关 case 在 71–120 行附近；import 区把 `listSkills`、`deleteSkill` 换成新原语，`readSkillFile` 保留）：

1. `case "list_skills"`：把现调用 `listSkills()` 换成 `listSkillsMerged()`（try/catch 与 respond 结构原样保留）。
2. `case "read_skill_file"`：调用处改为——

```ts
        const p = msg.params as ReadSkillFileParams;
        const located = resolveSkillRoot(p.name);
        // 未命中任何根 → 按主根路径读，让 ENOENT 自然抛出（错误语义与单根时代一致）
        const content = readSkillFile(p.name, p.path, located?.root ?? paths.skillsDir);
```

（`paths` 若未 import 则补 `import { paths } from "./paths";`。）

3. `case "delete_skill"`：调用 `deleteSkill(p.name)` 换成 `deleteSkillGuarded(p.name)`，catch 改为透传 code（与 `run_skill_script` case 同模式）：

```ts
      } catch (e) {
        const code = (e as { code?: string }).code ?? "delete_skill_failed";
        log("error", "delete_skill.failed", { id, code, error: String(e) });
        return respond({ ok: false, error: { code, message: String(e) } });
      }
```

- [ ] **Step 2: 跑 daemon 全量测试**

```bash
cd daemon && bun test   # 期望全绿；行为断言已由 Task 2 单测覆盖，本 task 是纯接线
```

- [ ] **Step 3: 提交**

```bash
git add daemon/src/daemon.ts
git commit -m "feat(daemon): dispatcher 接多根——list 合并/read 解析根/delete read_only 透传"
```

---

### Task 4: skill-exec 多根定位

**Files:**
- Modify: `daemon/src/skill-exec.ts:13-19`（SkillExecDeps）与 `:50-57, :86`（定位逻辑）
- Test: `daemon/test/skill-exec-multiroot.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `SkillRoots` / `resolveSkillRoot` / `defaultRoots`
- Produces: `SkillExecDeps.roots?: SkillRoots`（`skillsRoot` 保留为单根别名：等价 `{ primary: skillsRoot }`，**不带默认副根**——防既有测试漏进真实 `~/.agents`）

- [ ] **Step 1: 写失败测试**

新建 `daemon/test/skill-exec-multiroot.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSkillScript } from "../src/skill-exec";
import { putGrant, grantKey, canonicalEnvelope } from "../src/grants";
import type { SkillSandbox } from "../src/skill-sandbox";

let primary: string;
let secondary: string;
let grantsPath: string;
let auditPath: string;

beforeEach(() => {
  primary = mkdtempSync(join(tmpdir(), "pie-xmr-p-"));
  secondary = mkdtempSync(join(tmpdir(), "pie-xmr-s-"));
  const misc = mkdtempSync(join(tmpdir(), "pie-xmr-m-"));
  grantsPath = join(misc, "grants.json");
  auditPath = join(misc, "audit.jsonl");
});
afterEach(() => {
  rmSync(primary, { recursive: true, force: true });
  rmSync(secondary, { recursive: true, force: true });
});

function putSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
  writeFileSync(join(dir, "scripts", "run.sh"), "echo ok");
}

function grantFor(name: string): void {
  const envelope = canonicalEnvelope({ allowedDomains: [], extraWrites: [], runnableScripts: ["run.sh"] });
  putGrant({ key: grantKey(name, envelope), skillName: name, envelope, grantedAt: 1 }, grantsPath);
}

test("副根 skill 可执行：cwd/argv 指向副根目录，workspace 建在副根 skill 目录内", async () => {
  putSkill(secondary, "agentskill");
  grantFor("agentskill");
  const calls: { argv: string[]; cwd: string }[] = [];
  const sandbox: SkillSandbox = {
    run: async (argv, cwd) => {
      calls.push({ argv: argv as string[], cwd: cwd as string });
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    },
  };
  const res = await runSkillScript(
    { name: "agentskill", entry: "run.sh" },
    { roots: { primary, secondary }, grantsPath, auditPath, sandbox, now: () => 1 },
  );
  expect(res.output).toBe("ok");
  expect(calls[0].cwd).toBe(join(secondary, "agentskill"));
  expect(calls[0].argv.join(" ")).toContain(join(secondary, "agentskill", "scripts", "run.sh"));
  expect(existsSync(join(secondary, "agentskill", "workspace"))).toBe(true);
});

test("同名遮蔽：主根版本被执行", async () => {
  putSkill(primary, "dup");
  putSkill(secondary, "dup");
  grantFor("dup");
  const calls: { cwd: string }[] = [];
  const sandbox: SkillSandbox = {
    run: async (_argv, cwd) => {
      calls.push({ cwd: cwd as string });
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    },
  };
  await runSkillScript(
    { name: "dup", entry: "run.sh" },
    { roots: { primary, secondary }, grantsPath, auditPath, sandbox, now: () => 1 },
  );
  expect(calls[0].cwd).toBe(join(primary, "dup"));
});

test("两根都无 → unknown_skill", async () => {
  let err: unknown;
  try {
    await runSkillScript(
      { name: "ghost", entry: "run.sh" },
      { roots: { primary, secondary }, grantsPath, auditPath, now: () => 1 },
    );
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string }).code).toBe("unknown_skill");
});
```

注：若 `SkillSandbox.run` 的真实签名与上面的 fake 不匹配（参数名/返回字段），以 `daemon/src/skill-sandbox.ts` 的类型为准调整 fake——断言点（cwd、argv、workspace）不变。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd daemon && bun test test/skill-exec-multiroot.test.ts
```
期望：FAIL —— `SkillExecDeps` 无 `roots` 字段（TS 报错或运行期落到 defaultRoots 找不到 skill）。

- [ ] **Step 3: 实现**

`daemon/src/skill-exec.ts`：

1. import 区补：`import { assertSkillName, listSkills, resolveSkillRoot, defaultRoots } from "./skill-store"; import type { SkillRoots } from "./skill-store";`（原有 import 项保留）。
2. `SkillExecDeps` 改为：

```ts
export interface SkillExecDeps {
  sandbox?: SkillSandbox;
  now?: () => number;
  /** 单根别名（既有测试用）：等价 roots={primary: skillsRoot}，不带默认副根 */
  skillsRoot?: string;
  roots?: SkillRoots;
  grantsPath?: string;
  auditPath?: string;
}
```

3. `runSkillScript` 开头的定位逻辑（原 `const skillsRoot = deps.skillsRoot ?? paths.skillsDir;` 与 `const summary = listSkills(skillsRoot).find(...)`）改为：

```ts
  const roots: SkillRoots = deps.roots ?? (deps.skillsRoot ? { primary: deps.skillsRoot } : defaultRoots);
  ...
  const name = assertSkillName(params.name);
  const located = resolveSkillRoot(name, roots);
  if (!located) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
  const summary = listSkills(located.root).find((s) => s.name === name);
  if (!summary) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
```

4. 原 `const skillDir = join(skillsRoot, name);` 改为 `const skillDir = join(located.root, name);`（workspace/argv/sandbox 调用随 `skillDir` 自动落到正确根，无需再改）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd daemon && bun test test/skill-exec-multiroot.test.ts   # 期望 3 pass
cd daemon && bun test                                      # 全绿（既有 skill-exec.test.ts 走 skillsRoot 别名不回归）
```

- [ ] **Step 5: 提交**

```bash
git add daemon/src/skill-exec.ts daemon/test/skill-exec-multiroot.test.ts
git commit -m "feat(daemon): skill-exec 多根定位——副根脚本可执行，授权/沙箱/audit 语义不变"
```

---

### Task 5: 扩展侧 source 透传 + filterEnabled 副根默认关

**Files:**
- Modify: `src/lib/skills/source.ts:12-22`（SkillEntry）与 `:109-117`（filterEnabled）
- Modify: `src/background/daemon-skill-source.ts:9-21`（list 映射）
- Test: `src/lib/skills/source-multiroot.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `SkillSummary.source`
- Produces: `SkillEntry.source?: "pie" | "agents"`（Task 6/7 依赖）；`filterEnabled` 新默认规则

- [ ] **Step 1: 写失败测试**

新建 `src/lib/skills/source-multiroot.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { filterEnabled, type SkillEntry } from "./source";

function entry(over: Partial<SkillEntry>): SkillEntry {
  return {
    id: "x",
    name: "x",
    description: "d",
    builtIn: false,
    origin: "disk",
    files: [],
    runnableScripts: [],
    ...over,
  };
}

describe("filterEnabled 多根默认规则", () => {
  it("主根磁盘 skill（source: pie）默认开", () => {
    expect(filterEnabled([entry({ id: "a", source: "pie" })], [])).toHaveLength(1);
  });

  it("磁盘 skill 无 source（旧 daemon）默认开", () => {
    expect(filterEnabled([entry({ id: "a" })], [])).toHaveLength(1);
  });

  it("副根 skill（source: agents）默认关", () => {
    expect(filterEnabled([entry({ id: "a", source: "agents" })], [])).toHaveLength(0);
  });

  it("副根 skill 有 plain marker → 开", () => {
    expect(filterEnabled([entry({ id: "a", source: "agents" })], ["a"])).toHaveLength(1);
  });

  it("副根 skill 有 !marker → 关", () => {
    expect(filterEnabled([entry({ id: "a", source: "agents" })], ["!a"])).toHaveLength(0);
  });

  it("IDB 用户 skill 仍默认关（回归）", () => {
    expect(filterEnabled([entry({ id: "a", origin: "idb" })], [])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run src/lib/skills/source-multiroot.test.ts
```
期望：FAIL —— "副根 skill 默认关" 一例失败（现行规则 `origin === "disk"` 无条件默认开），且 `source` 字段 TS 报错。

- [ ] **Step 3: 实现**

`src/lib/skills/source.ts`：

1. `SkillEntry` 加字段（`origin` 之后）：

```ts
  /** 磁盘来源根（daemon 模式）："pie"=主根 ~/.pie/skills，"agents"=只读副根 ~/.agents/skills。
   *  IDB/builtin 恒 undefined；旧 daemon 不给时视同 "pie"。 */
  source?: "pie" | "agents";
```

2. `filterEnabled` 的默认行（`return e.builtIn || BUILT_IN_IDS.has(e.id) || e.origin === "disk";`）改为：

```ts
    // 磁盘默认开只给主根（放上 ~/.pie/skills = 意图）；副根 ~/.agents/skills 是
    // 别的 agent 生态的目录，默认关，经首连导入向导 / 列表开关显式启用。
    return e.builtIn || BUILT_IN_IDS.has(e.id) || (e.origin === "disk" && e.source !== "agents");
```

`src/background/daemon-skill-source.ts` 的 `list()` 映射对象加一行：

```ts
      source: s.source ?? "pie", // 旧 daemon 无 source → 主根语义
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run src/lib/skills/source-multiroot.test.ts   # 期望 6 pass
pnpm test                                                  # 全绿（filterEnabled 既有用例不回归）
pnpm typecheck
```

- [ ] **Step 5: 提交**

```bash
git add src/lib/skills/source.ts src/background/daemon-skill-source.ts src/lib/skills/source-multiroot.test.ts
git commit -m "feat(skills): SkillEntry.source 透传 + filterEnabled 副根默认关（主根/旧 daemon 语义不变）"
```

---

### Task 6: SkillsList 只读行（badge + 隐藏编辑/删除）+ i18n

**Files:**
- Modify: `src/sidepanel/components/SkillsList.tsx:290-388`（SkillRow）
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,ja,es-419,pt-BR}.ts`（skills 段）
- Test: `src/sidepanel/components/SkillsList.multiroot.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 5 的 `SkillEntry.source`
- Produces: i18n key `skills.sourceTag.agents`（Task 7 同段追加，注意合并）

- [ ] **Step 1: 写失败测试**

新建 `src/sidepanel/components/SkillsList.multiroot.test.tsx`（render/i18n 包装、`afterEach(cleanup)` 等 house 模式对照 `src/sidepanel/components/SkillGrantCard.test.tsx` 现行写法）：

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import SkillsList from "./SkillsList";
import type { SkillEntry } from "@/lib/skills/source";

const listSkillEntries = vi.fn();
vi.mock("@/lib/skills/panel-actions", () => ({
  listSkillEntries: (...a: unknown[]) => listSkillEntries(...a),
  readSkillFileRpc: vi.fn(),
  writeSkillRpc: vi.fn(),
  deleteSkillRpc: vi.fn(),
}));
vi.mock("@/lib/skills", () => ({
  getEnabledSkillIds: vi.fn().mockResolvedValue([]),
  setSkillEnabled: vi.fn(),
  generateUserSkillId: () => "skill_user_test",
}));
const getConfig = vi.fn();
const setConfig = vi.fn();
vi.mock("@/lib/idb/config-store", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  setConfig: (...a: unknown[]) => setConfig(...a),
}));

function entry(over: Partial<SkillEntry>): SkillEntry {
  return {
    id: "x", name: "x", description: "d", builtIn: false, origin: "disk",
    files: [], runnableScripts: [], ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue(true); // 向导已提示过（Task 7 之前恒 true 不弹）
});
afterEach(cleanup);

describe("SkillsList 副根只读行", () => {
  it("agents 行显示来源 badge，无编辑/删除按钮；pie 行保留", async () => {
    listSkillEntries.mockResolvedValue({
      ok: true,
      skills: [
        entry({ id: "mine", name: "mine", source: "pie" }),
        entry({ id: "shared", name: "shared", source: "agents" }),
      ],
    });
    render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(screen.getByText("/shared")).toBeTruthy());
    expect(screen.getByText("~/.agents")).toBeTruthy(); // 来源 badge
    const editButtons = screen.getAllByText("Edit");
    expect(editButtons).toHaveLength(1); // 只有 pie 行有
    expect(screen.getAllByText("Delete")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run src/sidepanel/components/SkillsList.multiroot.test.tsx
```
期望：FAIL —— badge 文本不存在、Edit/Delete 各出现 2 次。

- [ ] **Step 3: 实现**

`src/sidepanel/components/SkillsList.tsx` 的 `SkillRow`：

1. tag 计算改为（`skill.builtIn` 分支之后插一层）：

```ts
  const tag = skill.builtIn
    ? t("skills.authorTag.builtIn")
    : skill.source === "agents"
      ? t("skills.sourceTag.agents")
      : skill.author === "agent"
        ? t("skills.authorTag.agent")
        : t("skills.authorTag.user");
```

2. 编辑/删除按钮的包裹条件 `{!skill.builtIn && (` 改为 `{!skill.builtIn && skill.source !== "agents" && (`（Run 按钮与开关不动——副根 skill 可启用可运行，只是不可改）。

i18n 六字典的 `skills` 段各加（`authorTag` 之后）：

```ts
    sourceTag: { agents: "~/.agents" },
```

（六份相同——路径字面量跨语言自明，无需翻译；key parity 仍须六份齐全。）

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run src/sidepanel/components/SkillsList.multiroot.test.tsx   # 期望 pass
pnpm typecheck && pnpm test                                               # 全绿
```

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/SkillsList.tsx src/sidepanel/components/SkillsList.multiroot.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(panel): 副根 skill 只读行——~/.agents 来源 badge + 隐藏编辑/删除"
```

---

### Task 7: 首连导入向导

**Files:**
- Modify: `src/sidepanel/components/SkillsList.tsx`（父组件状态 + 内部子组件 `AgentsImportCard`）
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,ja,es-419,pt-BR}.ts`（skills 段）
- Test: 追加到 `src/sidepanel/components/SkillsList.multiroot.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `source`、`@/lib/idb/config-store` 的 `getConfig`/`setConfig`、`@/lib/skills` 的 `setSkillEnabled`
- Produces: IDB config key `"agents_import_prompted"`（boolean）

- [ ] **Step 1: 写失败测试**

追加到 `SkillsList.multiroot.test.tsx`：

```tsx
describe("首连导入向导", () => {
  const twoAgents = {
    ok: true,
    skills: [
      entry({ id: "s1", name: "s1", source: "agents" }),
      entry({ id: "s2", name: "s2", source: "agents" }),
    ],
  };

  it("条件满足（有 agents skill 且未提示过）→ 弹卡", async () => {
    getConfig.mockResolvedValue(undefined); // 未提示过
    listSkillEntries.mockResolvedValue(twoAgents);
    render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(screen.getByText(/local skills/i)).toBeTruthy());
  });

  it("已提示过 → 不弹", async () => {
    getConfig.mockResolvedValue(true);
    listSkillEntries.mockResolvedValue(twoAgents);
    render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(screen.getByText("/s1")).toBeTruthy());
    expect(screen.queryByText(/local skills/i)).toBeNull();
  });

  it("无 agents skill → 不弹", async () => {
    getConfig.mockResolvedValue(undefined);
    listSkillEntries.mockResolvedValue({ ok: true, skills: [entry({ id: "mine", source: "pie" })] });
    render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(screen.getByText("/mine")).toBeTruthy());
    expect(screen.queryByText(/local skills/i)).toBeNull();
  });

  it("勾选 + 确认 → setSkillEnabled(true) × 勾选数 + 落标记", async () => {
    const { setSkillEnabled } = await import("@/lib/skills");
    getConfig.mockResolvedValue(undefined);
    listSkillEntries.mockResolvedValue(twoAgents);
    const { getByText, getAllByRole } = render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(getByText(/local skills/i)).toBeTruthy());
    fireEvent.click(getAllByRole("checkbox")[0]); // 勾 s1
    fireEvent.click(getByText("Enable selected"));
    await waitFor(() => expect(setConfig).toHaveBeenCalledWith("agents_import_prompted", true));
    expect(setSkillEnabled).toHaveBeenCalledTimes(1);
    expect(setSkillEnabled).toHaveBeenCalledWith("s1", true);
  });

  it("暂不 → 只落标记，不启用任何 skill", async () => {
    const { setSkillEnabled } = await import("@/lib/skills");
    getConfig.mockResolvedValue(undefined);
    listSkillEntries.mockResolvedValue(twoAgents);
    const { getByText } = render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(getByText(/local skills/i)).toBeTruthy());
    fireEvent.click(getByText("Not now"));
    await waitFor(() => expect(setConfig).toHaveBeenCalledWith("agents_import_prompted", true));
    expect(setSkillEnabled).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run src/sidepanel/components/SkillsList.multiroot.test.tsx
```
期望：新 5 例全 FAIL（卡片不存在）。

- [ ] **Step 3: 实现**

`src/sidepanel/components/SkillsList.tsx`：

1. import 区补：`import { getConfig, setConfig } from "@/lib/idb/config-store";`
2. 模块级常量：`const AGENTS_IMPORT_PROMPTED_KEY = "agents_import_prompted";`
3. 父组件状态与处理器（`confirmDeleteId` state 之后）：

```tsx
  // 首连导入向导：null=标记加载中（不闪卡），false=未提示过，true=已提示
  const [importPrompted, setImportPrompted] = useState<boolean | null>(null);

  useEffect(() => {
    void getConfig<boolean>(AGENTS_IMPORT_PROMPTED_KEY).then((v) => setImportPrompted(v ?? false));
  }, []);

  const agentsSkills = skills.filter((s) => s.source === "agents");

  async function handleImportConfirm(ids: string[]) {
    for (const id of ids) await setSkillEnabled(id, true);
    await setConfig(AGENTS_IMPORT_PROMPTED_KEY, true);
    setImportPrompted(true);
    await loadSkills();
  }

  async function handleImportDismiss() {
    await setConfig(AGENTS_IMPORT_PROMPTED_KEY, true);
    setImportPrompted(true);
  }
```

4. JSX：concept-hint 块之后、`{showForm && ...}` 之前插入：

```tsx
      {importPrompted === false && agentsSkills.length > 0 && (
        <AgentsImportCard
          skills={agentsSkills}
          onConfirm={(ids) => void handleImportConfirm(ids)}
          onDismiss={() => void handleImportDismiss()}
        />
      )}
```

5. 文件末尾加子组件（样式沿用本文件 `SkillForm`/`SkillsSection` 的 token 族）：

```tsx
function AgentsImportCard({
  skills,
  onConfirm,
  onDismiss,
}: {
  skills: SkillEntry[];
  onConfirm: (ids: string[]) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const allChecked = checked.size === skills.length;

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">
          {t("skills.agentsImport.title", { count: skills.length })}
        </span>
        <button
          onClick={() => setChecked(allChecked ? new Set() : new Set(skills.map((s) => s.id)))}
          className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
        >
          {t("skills.agentsImport.selectAll")}
        </button>
      </div>
      <p className="text-[12px] leading-[18px] text-fg-2">{t("skills.agentsImport.body")}</p>
      <div className="flex max-h-56 flex-col overflow-y-auto rounded-[10px] border border-line">
        {skills.map((s) => (
          <label
            key={s.id}
            className="flex cursor-pointer items-center gap-2.5 border-t border-line px-3 py-2 first:border-t-0"
          >
            <input type="checkbox" checked={checked.has(s.id)} onChange={() => toggle(s.id)} />
            <code className="font-mono text-[12px] text-fg-1">{s.name}</code>
            <span className="ml-auto min-w-0 truncate text-[11px] text-fg-3">{s.description}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onDismiss}
          className="rounded-[10px] border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:text-fg-1"
        >
          {t("skills.agentsImport.dismiss")}
        </button>
        <button
          onClick={() => onConfirm([...checked])}
          disabled={checked.size === 0}
          className="rounded-[10px] bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("skills.agentsImport.confirm")}
        </button>
      </div>
    </section>
  );
}
```

6. i18n 六字典 `skills` 段各加 `agentsImport`（`sourceTag` 之后）：

en:
```ts
    agentsImport: {
      title: "Found {count} local skills",
      body: "These live in ~/.agents/skills (shared across agents). Choose which ones Pie can use — you can change this anytime in this list.",
      selectAll: "Select all",
      confirm: "Enable selected",
      dismiss: "Not now",
    },
```
zh-CN:
```ts
    agentsImport: {
      title: "发现 {count} 个本地 skill",
      body: "它们来自 ~/.agents/skills（跨 agent 共享目录）。勾选允许 Pie 使用的条目——之后随时可在本列表中开关。",
      selectAll: "全选",
      confirm: "启用所选",
      dismiss: "暂不",
    },
```
zh-TW:
```ts
    agentsImport: {
      title: "發現 {count} 個本地 skill",
      body: "它們來自 ~/.agents/skills（跨 agent 共享目錄）。勾選允許 Pie 使用的條目——之後隨時可在本列表中開關。",
      selectAll: "全選",
      confirm: "啟用所選",
      dismiss: "暫不",
    },
```
ja:
```ts
    agentsImport: {
      title: "ローカルスキルを {count} 件検出しました",
      body: "~/.agents/skills（エージェント間共有ディレクトリ）にあるスキルです。Pie で使うものを選んでください。後からこのリストでいつでも変更できます。",
      selectAll: "すべて選択",
      confirm: "選択を有効化",
      dismiss: "あとで",
    },
```
es-419:
```ts
    agentsImport: {
      title: "Se encontraron {count} skills locales",
      body: "Provienen de ~/.agents/skills (directorio compartido entre agentes). Elige cuáles puede usar Pie; puedes cambiarlo en esta lista cuando quieras.",
      selectAll: "Seleccionar todo",
      confirm: "Habilitar seleccionados",
      dismiss: "Ahora no",
    },
```
pt-BR:
```ts
    agentsImport: {
      title: "Encontramos {count} skills locais",
      body: "Elas vêm de ~/.agents/skills (diretório compartilhado entre agentes). Escolha quais o Pie pode usar — você pode mudar isso nesta lista a qualquer momento.",
      selectAll: "Selecionar tudo",
      confirm: "Habilitar selecionadas",
      dismiss: "Agora não",
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run src/sidepanel/components/SkillsList.multiroot.test.tsx   # 期望全 pass
pnpm typecheck && pnpm test                                               # 全绿
```

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/SkillsList.tsx src/sidepanel/components/SkillsList.multiroot.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(panel): 首连导入向导——发现 ~/.agents skills 一次性多选启用（关闭同落标记）"
```

---

### Task 8: 收尾——CLAUDE.md 更新 + 全量门禁

**Files:**
- Modify: `CLAUDE.md`（skills bullet）

- [ ] **Step 1: CLAUDE.md skills bullet 补双根一句**

在 `CLAUDE.md` 的 `src/lib/skills/` 条目中，`**daemon 连接且声明 \`skill_fs\` 时磁盘为唯一真源**（\`~/.pie/skills/<name>/\`` 这一处之后，紧跟着补：

```
双根：`~/.agents/skills` 为只读副根（跨 agent 通用目录），daemon skill-store 层合并、主根遮蔽同名、写恒落主根（CoW）、副根删除报 `read_only`；副根 skill 默认关（`filterEnabled` 按 `source` 收窄磁盘默认开），首连经 SkillsList 导入向导多选启用（`agents_import_prompted` 标记）。
```

- [ ] **Step 2: 全量门禁**

```bash
pnpm test        # 期望全绿
pnpm typecheck   # 期望 0 错
pnpm build       # 期望成功（build-time invariants 通过）
cd daemon && bun test && cd ..   # 期望全绿
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md skills 条目补双根语义"
```

---

## 真机验收清单（merge 前人工过一遍，对应 spec §10）

1. `~/.agents/skills` 的 skill 出现在列表、带 `~/.agents` badge、默认禁用、无编辑/删除按钮
2. 清掉 `agents_import_prompted`（或新 profile）→ 打开 skills 页弹向导；勾 2 个确认 → 该 2 个启用且进 slash popover；「暂不」后刷新不再弹
3. 副根 skill 启用后：正文可被 `use_skill` 读到；`scripts/` 脚本首跑弹授权卡，批准后执行成功（py/sh/ts 各验一，观察 `~/.agents/skills/<name>/workspace/` 出现但既有文件未变）
4. `~/.pie/skills` 放同名 skill → 列表只剩主根版（badge 消失）；删除它 → 副根版恢复
5. LLM 调 `delete_skill` 删副根 skill → 报 read-only 错误且带路径；`~/.agents` 文件不变
6. 关掉「本地打通」（IDB 模式）→ 列表/行为与现状完全一致
