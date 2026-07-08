# Slice 2b — skill 特权脚本 daemon 路径（fs-only）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 带 `fs` 声明的特权 skill 脚本能经本地 daemon 在 `sandbox-exec` OS 级隔离下执行——首次弹 HITL 授权卡（perms 原文）、批准即持久 grant（`skill:<id>:<permsHash>`，permsHash 含脚本内容 hash）、设置页可撤销、每次执行写 audit；`network` 声明仍回结构化错误（留给 Slice 2c）。

**Architecture:** 扩展 tool handler 从已安装包解析脚本内容（LLM 只传 id/entry/input），路由：纯计算 → 2a sandbox（不动）；fs-only 特权 → daemon `run_skill_script`。daemon 查 `~/.pie/grants.json` 账本 miss → 回 `needs_authorization` → 扩展弹卡 → 批准重调带 `grantApproved` → daemon 写 grant + 在 `~/.pie/skills/<id>/workspace/` 用 `BUN_BE_BUN=1 sandbox-exec -f profile pie run runner entry input` 执行（60s 超时 / 1MB 输出上限 / fs 写限 skill 目录 / 网络全断）+ 写 audit。结果包 `<untrusted_skill_content>` 回 observation。

**Tech Stack:** daemon = Bun（`daemon/`，bun test）；扩展 = React 19 + TS，vitest + happy-dom。协议类型单一源 `src/types/local-bridge.ts`（daemon 相对 import，不复制）。

**Spec:** `docs/specs/2026-07-05-local-daemon-bridge.md` §4.4（含 2026-07-09「交付切分」定稿）、§6.1 授权矩阵、§6.3 daemon 防线。两个 spike 已验证：`BUN_BE_BUN=1 ~/.pie/bin/pie run x.js` 编译二进制当裸 bun 用；`sandbox-exec` profile 对 fs 写 OS 级真隔离（workspace 外写被拒、网络全断）。

## Global Constraints

- **LLM 永远不能注入代码**：`run_skill_script` 只从 LLM 收 `skillId + entry + input`；脚本内容由扩展 tool handler 从已安装包（`resolveSkillPackage`）解析后随 wire 传给 daemon。daemon 收到的 `code` 是扩展的责任边界，不是 LLM 输入。
- **2b 前置项（终审交办）**：privileged 路由前扩展必须校验 skill **已启用**（`getEnabledSkillPackages` 含该 id）——2a 纯计算沙箱隔离可放宽，2b 放行本地执行不能跑禁用 skill 的脚本。
- **network 一律不放行（2b）**：扩展侧 `decl.network.length > 0` → 结构化 `privileged_script:` 错误指向 2c；daemon 侧**防御性**同样拒（`network_not_supported`）——belt-and-suspenders，即便扩展被绕过 daemon 也不在 2b 执行网络脚本。
- **grant 身份 = `skill:<id>:<permsHash>`，permsHash = sha256(canonical(perms) + "\n" + code) 前 32 hex**：含脚本内容 → agent-authored skill 改代码即 hash 变 → grant 自动失效重弹卡（spec §6.1，2026-07-08 修订，用户拍板）。canonical(perms) = `JSON.stringify({fs, network: [...network].sort()})`。
- **grants 账本 daemon 独占**（`~/.pie/grants.json`，扩展零 grant 存储）：强制流 = 扩展调 daemon → daemon 查账本 → miss 回 `needs_authorization` → 扩展弹卡 → 批准重调 → daemon 写 grant + 执行。撤销 = daemon 删条目。写盘 write-temp-rename 原子。
- **执行护栏（daemon 侧硬强制）**：60s 超时（超时 kill 进程）、1MB 输出上限（增量读到上限即停+kill+truncated 标记）、fs 写限 `~/.pie/skills/<id>/` 子树、网络 `(deny network*)`、cwd = `workspace/`。
- **授权卡展示 perms 原文**，不经 LLM 转述（spec §6.1 invariant：write 类本地动作无静默路径）。
- **PROTOCOL_VERSION 保持 1**（加方法只增不改语义）；新增 capabilities `run_skill_script` / `list_grants` / `revoke_grant`，daemon 未声明时扩展降级（privileged → 结构化「需要本地组件」错误，纯计算路径不受影响）。
- **脚本输出是 untrusted**：daemon 返回的 output 一律包 `<untrusted_skill_content>` 经 `escapeUntrustedWrappers`（扩展侧，与 2a 同一出口）。
- **新 panel-request kind 编译期登记**：`skill-grant` 加进 `PanelRequestMap`（`src/lib/panel-request.ts`），req/res 类型编译期校验。
- i18n 6 字典 parity（en/zh-CN/zh-TW/es-419/ja/pt-BR）；无 jest-dom → `.toBeTruthy()`；RTL 固定 `afterEach(() => cleanup())`。
- 提交前 daemon `cd daemon && bun test`、扩展 `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿。

---

### Task 1: daemon grants 账本 + paths 扩展

**Files:**
- Modify: `daemon/src/paths.ts`（加 `skillsDir` / `grantsPath` / `auditPath`）
- Create: `daemon/src/grants.ts`
- Create: `daemon/test/grants.test.ts`

**Interfaces:**
- Consumes: `paths`（同目录）
- Produces: `ScriptPerms { fs: boolean; network: string[] }`、`GrantRecord { key; skillId; entry; perms; grantedAt }`、`permsHash(perms, code): string`、`grantKey(skillId, hash): string`、`hasGrant(skillId, perms, code, path?): boolean`、`putGrant(record, path?): void`、`listGrants(path?): GrantRecord[]`、`revokeGrant(key, path?): boolean`——Task 2/3 依赖。

- [ ] **Step 1: paths 扩展**

`daemon/src/paths.ts` 的 `paths` 对象加三个字段（`skillsDir` 在 pieDir 下）：

```ts
export const paths = {
  pieDir,
  socketPath: join(pieDir, "daemon.sock"),
  handoffsDir: join(homedir(), "pie-handoffs"),
  logsDir: join(pieDir, "logs"),
  skillsDir: join(pieDir, "skills"),
  grantsPath: join(pieDir, "grants.json"),
  auditPath: join(pieDir, "logs", "audit.jsonl"),
};
```

- [ ] **Step 2: Write failing tests**

`daemon/test/grants.test.ts`（bun test；用 `import { test, expect, beforeEach } from "bun:test"`；每测用临时文件路径，避免碰真实 `~/.pie`）:

```ts
import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdtempSync } from "fs";
import {
  permsHash,
  grantKey,
  hasGrant,
  putGrant,
  listGrants,
  revokeGrant,
  type ScriptPerms,
} from "../src/grants";

function tmpGrants(): string {
  const dir = mkdtempSync(join(tmpdir(), "pie-grants-"));
  return join(dir, "grants.json");
}
const FS: ScriptPerms = { fs: true, network: [] };

test("permsHash 含脚本内容：改代码即变", () => {
  const a = permsHash(FS, "export default () => 1");
  const b = permsHash(FS, "export default () => 2");
  expect(a).not.toBe(b);
  expect(a).toHaveLength(32);
});

test("permsHash 对 network 顺序不敏感（canonical 排序）", () => {
  const p1: ScriptPerms = { fs: true, network: ["b.com", "a.com"] };
  const p2: ScriptPerms = { fs: true, network: ["a.com", "b.com"] };
  expect(permsHash(p1, "x")).toBe(permsHash(p2, "x"));
});

test("hasGrant：miss → false；putGrant 后 → true；改代码后 → false", () => {
  const path = tmpGrants();
  const code = "export default () => 1";
  expect(hasGrant("s1", FS, code, path)).toBe(false);
  putGrant(
    { key: grantKey("s1", permsHash(FS, code)), skillId: "s1", entry: "scripts/a.js", perms: FS, grantedAt: 111 },
    path,
  );
  expect(hasGrant("s1", FS, code, path)).toBe(true);
  expect(hasGrant("s1", FS, "export default () => 2", path)).toBe(false); // 换代码即失效
});

test("listGrants 列出记录；revokeGrant 删除并返回是否命中", () => {
  const path = tmpGrants();
  const key = grantKey("s1", permsHash(FS, "c"));
  putGrant({ key, skillId: "s1", entry: "a.js", perms: FS, grantedAt: 1 }, path);
  expect(listGrants(path).map((g) => g.key)).toEqual([key]);
  expect(revokeGrant(key, path)).toBe(true);
  expect(listGrants(path)).toEqual([]);
  expect(revokeGrant(key, path)).toBe(false); // 已不在
});

test("坏 grants.json → 当空账本（韧性，不 throw）", () => {
  const path = tmpGrants();
  require("fs").writeFileSync(path, "{ not json");
  expect(listGrants(path)).toEqual([]);
  expect(hasGrant("s1", FS, "c", path)).toBe(false);
});
```

- [ ] **Step 3: Run → fail**

Run: `cd daemon && bun test test/grants.test.ts`
Expected: FAIL —— `Cannot find module "../src/grants"`

- [ ] **Step 4: Implement**

`daemon/src/grants.ts`:

```ts
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";

export interface ScriptPerms {
  fs: boolean;
  network: string[];
}
export interface GrantRecord {
  key: string;
  skillId: string;
  entry: string;
  perms: ScriptPerms;
  grantedAt: number;
}
interface GrantsFile {
  version: number;
  grants: Record<string, GrantRecord>;
}

// permsHash = sha256(canonical(perms) + "\n" + code) 前 32 hex。含脚本内容：
// agent-authored skill 改脚本代码即 hash 变 → grant 自动失效重弹卡（spec §6.1）。
export function permsHash(perms: ScriptPerms, code: string): string {
  const canon = JSON.stringify({ fs: perms.fs, network: [...perms.network].sort() });
  return createHash("sha256").update(canon + "\n" + code).digest("hex").slice(0, 32);
}

export function grantKey(skillId: string, hash: string): string {
  return `skill:${skillId}:${hash}`;
}

function read(path: string): GrantsFile {
  if (!existsSync(path)) return { version: 1, grants: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GrantsFile;
    return parsed && typeof parsed === "object" && parsed.grants ? parsed : { version: 1, grants: {} };
  } catch {
    return { version: 1, grants: {} }; // 坏文件当空账本（韧性）
  }
}

function write(g: GrantsFile, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(g, null, 2));
  renameSync(tmp, path); // 原子替换
}

export function hasGrant(
  skillId: string,
  perms: ScriptPerms,
  code: string,
  path = paths.grantsPath,
): boolean {
  return grantKey(skillId, permsHash(perms, code)) in read(path).grants;
}

export function putGrant(record: GrantRecord, path = paths.grantsPath): void {
  const g = read(path);
  g.grants[record.key] = record;
  write(g, path);
}

export function listGrants(path = paths.grantsPath): GrantRecord[] {
  return Object.values(read(path).grants);
}

export function revokeGrant(key: string, path = paths.grantsPath): boolean {
  const g = read(path);
  if (!(key in g.grants)) return false;
  delete g.grants[key];
  write(g, path);
  return true;
}
```

- [ ] **Step 5: Run → pass**

Run: `cd daemon && bun test test/grants.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 6: Commit**

```bash
git add daemon/src/paths.ts daemon/src/grants.ts daemon/test/grants.test.ts
git commit -m "feat(daemon): grants 账本（permsHash 含脚本内容 + 原子写 + 列/撤）+ paths 扩展"
```

---

### Task 2: daemon skill 执行器 + audit

**Files:**
- Create: `daemon/src/audit.ts`
- Create: `daemon/src/skill-exec.ts`
- Create: `daemon/test/skill-exec.test.ts`

**Interfaces:**
- Consumes: Task 1 `hasGrant`/`putGrant`/`permsHash`/`grantKey`/`ScriptPerms`；`paths`；`RunSkillScriptParams`/`RunSkillScriptResult`（Task 3 加进 `src/types/local-bridge.ts`——本 task 先在 skill-exec.ts 顶部**从该文件 import 这两个类型**；若 Task 3 未先行，实现者需先加最小类型 stub，但按 plan 顺序 Task 3 在 Task 2 之后，故本 task 在 skill-exec.ts 内**本地定义**这两个 interface 并在 Task 3 迁移到共享文件时改为 import——见 Step 4 注释）。
- Produces: `buildSandboxProfile(skillDir: string): string`、`RUNNER_SOURCE: string`、`runSkillScript(params, deps?): Promise<RunSkillScriptResult>`、`SkillExecDeps`、`sanitizeSkillId(id): string`——Task 3 daemon.ts 依赖 `runSkillScript`。
- `appendAudit(entry, path?): void`（audit.ts）。

- [ ] **Step 1: audit.ts（先写，无测试——纯 best-effort 追加，逻辑平凡）**

`daemon/src/audit.ts`:

```ts
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";

export interface AuditEntry {
  ts: number;
  skillId: string;
  entry: string;
  perms: unknown;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

// best-effort：审计失败绝不阻断执行（spec §6.3 audit = 知情权，非闸）。
export function appendAudit(entry: AuditEntry, path = paths.auditPath): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    /* swallow */
  }
}
```

- [ ] **Step 2: Write failing tests**（注入 fake spawn，断言 profile / argv / grant 门禁 / 输出；真 spawn 走真机清单）

`daemon/test/skill-exec.test.ts`:

```ts
import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, existsSync } from "fs";
import { buildSandboxProfile, RUNNER_SOURCE, runSkillScript, sanitizeSkillId } from "../src/skill-exec";
import type { SkillExecDeps } from "../src/skill-exec";
import { putGrant, grantKey, permsHash, type ScriptPerms } from "../src/grants";

const FS: ScriptPerms = { fs: true, network: [] };
function tmpRoot() {
  const base = mkdtempSync(join(tmpdir(), "pie-exec-"));
  return { skillsRoot: join(base, "skills"), grantsPath: join(base, "grants.json"), auditPath: join(base, "audit.jsonl") };
}
function fakeSpawn(result: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }>) {
  const calls: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  const spawn: NonNullable<SkillExecDeps["spawn"]> = async (argv, cwd, env) => {
    calls.push({ argv, cwd, env });
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, ...result };
  };
  return { spawn, calls };
}
const P = (over = {}) => ({ skillId: "csv", entry: "scripts/a.js", code: "export default (i) => i", perms: FS, input: { a: 1 }, ...over });

test("buildSandboxProfile：fs 写限 skillDir、网络全断", () => {
  const prof = buildSandboxProfile("/home/u/.pie/skills/csv");
  expect(prof).toContain("(deny default)");
  expect(prof).toContain('(allow file-write* (subpath "/home/u/.pie/skills/csv"))');
  expect(prof).toContain("(deny network*)");
  expect(prof).toContain("(allow process-exec)");
});

test("RUNNER_SOURCE 调 default(input) 出 JSON", () => {
  expect(RUNNER_SOURCE).toContain("mod.default");
  expect(RUNNER_SOURCE).toContain("process.stdout.write");
});

test("network 声明 → network_not_supported（2b 防御性拒）", async () => {
  const { spawn, calls } = fakeSpawn({});
  const t = tmpRoot();
  await expect(
    runSkillScript(P({ perms: { fs: true, network: ["x.com"] } }), { spawn, ...t }),
  ).rejects.toMatchObject({ code: "network_not_supported" });
  expect(calls).toHaveLength(0); // 没到 spawn
});

test("无 grant 且未批准 → needs_authorization，零副作用", async () => {
  const { spawn, calls } = fakeSpawn({});
  const t = tmpRoot();
  await expect(runSkillScript(P(), { spawn, ...t })).rejects.toMatchObject({ code: "needs_authorization" });
  expect(calls).toHaveLength(0);
  expect(existsSync(t.grantsPath)).toBe(false); // 没写 grant
});

test("grantApproved → 写 grant + spawn；argv/env/cwd 正确", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: '{"a":1}' });
  const t = tmpRoot();
  const r = await runSkillScript(P({ grantApproved: true }), { spawn, now: () => 5000, ...t });
  expect(r.output).toBe('{"a":1}');
  // grant 落盘
  const { listGrants } = await import("../src/grants");
  expect(listGrants(t.grantsPath).map((g) => g.skillId)).toEqual(["csv"]);
  // argv: sandbox-exec -f <profile> <pieBin> run <runner> <entry> <input>
  const c = calls[0];
  expect(c.argv[0]).toBe("sandbox-exec");
  expect(c.argv[1]).toBe("-f");
  expect(c.argv).toContain("run");
  expect(c.env.BUN_BE_BUN).toBe("1");
  expect(c.cwd).toContain(join("skills", "csv", "workspace"));
});

test("已有 grant → 不需 grantApproved 直接跑", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: "null" });
  const t = tmpRoot();
  const code = "export default (i) => i";
  putGrant({ key: grantKey("csv", permsHash(FS, code)), skillId: "csv", entry: "scripts/a.js", perms: FS, grantedAt: 1 }, t.grantsPath);
  const r = await runSkillScript(P({ code }), { spawn, ...t });
  expect(r.output).toBe("null");
  expect(calls).toHaveLength(1);
});

test("timedOut → code:timeout；非零 exit → code:script_error（带 stderr 尾）", async () => {
  const t = tmpRoot();
  const g = (code: string) => putGrant({ key: grantKey("csv", permsHash(FS, code)), skillId: "csv", entry: "a", perms: FS, grantedAt: 1 }, t.grantsPath);
  g("export default (i) => i");
  await expect(
    runSkillScript(P({ grantApproved: true }), { spawn: fakeSpawn({ timedOut: true, exitCode: 143 }).spawn, ...t }),
  ).rejects.toMatchObject({ code: "timeout" });
  await expect(
    runSkillScript(P({ grantApproved: true }), { spawn: fakeSpawn({ exitCode: 1, stderr: "boom" }).spawn, ...t }),
  ).rejects.toMatchObject({ code: "script_error" });
});

test("truncated 标记透传", async () => {
  const { spawn } = fakeSpawn({ stdout: "x".repeat(10), truncated: true });
  const t = tmpRoot();
  const r = await runSkillScript(P({ grantApproved: true }), { spawn, ...t });
  expect(r.truncated).toBe(true);
});

test("sanitizeSkillId 去路径分隔符（防遍历）", () => {
  expect(sanitizeSkillId("../../etc")).not.toContain("/");
  expect(sanitizeSkillId("csv-utils")).toBe("csv-utils");
});

test("audit 落盘一行 JSON", async () => {
  const { spawn } = fakeSpawn({ stdout: "1" });
  const t = tmpRoot();
  await runSkillScript(P({ grantApproved: true }), { spawn, ...t });
  const lines = require("fs").readFileSync(t.auditPath, "utf8").trim().split("\n");
  expect(JSON.parse(lines[0]).skillId).toBe("csv");
});
```

- [ ] **Step 3: Run → fail**

Run: `cd daemon && bun test test/skill-exec.test.ts`
Expected: FAIL —— `Cannot find module "../src/skill-exec"`

- [ ] **Step 4: Implement**

`daemon/src/skill-exec.ts`:

```ts
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { paths } from "./paths";
import { log } from "./log";
import { hasGrant, putGrant, permsHash, grantKey, type ScriptPerms } from "./grants";
import { appendAudit } from "./audit";

// Task 3 把这两个 interface 迁进 src/types/local-bridge.ts（共享源）后，改成
// `import type { RunSkillScriptParams, RunSkillScriptResult } from "../../src/types/local-bridge"`。
// 本 task 先本地定义以保持可独立编译/测试。
export interface RunSkillScriptParams {
  skillId: string;
  entry: string;
  code: string; // 扩展从已安装包解析；LLM 传不了
  perms: ScriptPerms;
  input: unknown;
  grantApproved?: boolean;
}
export interface RunSkillScriptResult {
  output: string; // 脚本返回值 JSON string；<untrusted_skill_content> 包裹在扩展侧做
  truncated?: boolean;
}

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface SkillExecDeps {
  spawn?: (
    argv: string[],
    cwd: string,
    env: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }>;
  now?: () => number;
  skillsRoot?: string;
  grantsPath?: string;
  auditPath?: string;
}

/** skillId 来自扩展（已安装包 id），仍去路径分隔符防目录遍历。 */
export function sanitizeSkillId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// fs-only sandbox-exec profile：写限 skillDir 子树、网络全断、读放开（需读 pie
// 二进制+运行时+entry/input）、exec/fork 允许（bun self-spawn）。2c 才放网络。
export function buildSandboxProfile(skillDir: string): string {
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    `(allow file-write* (subpath ${JSON.stringify(skillDir)}))`,
    "(deny network*)",
    "",
  ].join("\n");
}

// runner：读 entry+input 绝对路径 → 动态 import → 调 default(input) → stdout JSON。
export const RUNNER_SOURCE = `const [entryPath, inputPath] = process.argv.slice(2);
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const mod = await import(entryPath);
if (typeof mod.default !== "function") { console.error("script must export default a function"); process.exit(3); }
const out = await mod.default(input);
process.stdout.write(JSON.stringify(out === undefined ? null : out));
`;

// 真 spawn：BUN_BE_BUN=1 让编译后的 pie 二进制当 bun 跑 runner；60s 超时 kill、
// 增量读 stdout 到 1MB 上限即停+kill（防脚本在超时窗口内狂吐撑爆内存）。
// ponytail: 真隔离靠 sandbox-exec，本函数只管进程生命周期+读上限；真 spawn 不
// 单测（注入 fake），走真机清单。
const realSkillSpawn: NonNullable<SkillExecDeps["spawn"]> = async (argv, cwd, env) => {
  const proc = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);
  try {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let stdout = "";
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += dec.decode(value, { stream: true });
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
        truncated = true;
        proc.kill();
        break;
      }
    }
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode, timedOut, truncated };
  } finally {
    clearTimeout(timer);
  }
};

export async function runSkillScript(
  params: RunSkillScriptParams,
  deps: SkillExecDeps = {},
): Promise<RunSkillScriptResult> {
  // 2b 防御性：sandbox-exec 做不到 per-domain，network 一律不在 2b 执行（→ 2c）。
  if (params.perms.network.length > 0) {
    throw Object.assign(new Error("network capability not supported yet (Slice 2c)"), {
      code: "network_not_supported",
    });
  }
  const now = deps.now ?? Date.now;
  const skillsRoot = deps.skillsRoot ?? paths.skillsDir;
  const grantsPath = deps.grantsPath ?? paths.grantsPath;
  const auditPath = deps.auditPath ?? paths.auditPath;
  const skillDir = join(skillsRoot, sanitizeSkillId(params.skillId));

  // grant 门禁：miss + 未批准 → needs_authorization（零副作用）；批准 → 写 grant。
  if (!hasGrant(params.skillId, params.perms, params.code, grantsPath)) {
    if (!params.grantApproved) {
      throw Object.assign(new Error("authorization required"), { code: "needs_authorization" });
    }
    putGrant(
      {
        key: grantKey(params.skillId, permsHash(params.perms, params.code)),
        skillId: params.skillId,
        entry: params.entry,
        perms: params.perms,
        grantedAt: now(),
      },
      grantsPath,
    );
  }

  const startedAt = now();
  const workspace = join(skillDir, "workspace");
  const runDir = join(skillDir, ".runs", String(startedAt));
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const entryPath = join(runDir, "entry.mjs");
  const inputPath = join(runDir, "input.json");
  const runnerPath = join(runDir, "runner.mjs");
  const profilePath = join(runDir, "profile.sb");
  writeFileSync(entryPath, params.code);
  writeFileSync(inputPath, JSON.stringify(params.input ?? null));
  writeFileSync(runnerPath, RUNNER_SOURCE);
  writeFileSync(profilePath, buildSandboxProfile(skillDir));

  const argv = ["sandbox-exec", "-f", profilePath, process.execPath, "run", runnerPath, entryPath, inputPath];
  const env = { BUN_BE_BUN: "1", TMPDIR: runDir }; // bun 临时/缓存进沙箱可写区
  const spawn = deps.spawn ?? realSkillSpawn;
  log("info", "skill.spawn", { skillId: params.skillId, entry: params.entry });

  let res;
  try {
    res = await spawn(argv, workspace, env);
  } finally {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* scratch cleanup best-effort */
    }
  }

  appendAudit(
    {
      ts: now(),
      skillId: params.skillId,
      entry: params.entry,
      perms: params.perms,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      truncated: res.truncated,
      ms: now() - startedAt,
    },
    auditPath,
  );

  if (res.timedOut) {
    throw Object.assign(new Error(`skill script timed out after ${TIMEOUT_MS}ms`), { code: "timeout" });
  }
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(`skill script exited ${res.exitCode}: ${res.stderr.trim().slice(-2000)}`), {
      code: "script_error",
    });
  }
  return { output: res.stdout, truncated: res.truncated || undefined };
}
```

- [ ] **Step 5: Run → pass**

Run: `cd daemon && bun test test/skill-exec.test.ts`
Expected: PASS（11 tests）

- [ ] **Step 6: Commit**

```bash
git add daemon/src/audit.ts daemon/src/skill-exec.ts daemon/test/skill-exec.test.ts
git commit -m "feat(daemon): skill 执行器（sandbox-exec fs 隔离 + grant 门禁 + 60s/1MB 护栏 + audit）"
```

---

### Task 3: 协议类型 + daemon wire（run_skill_script / list_grants / revoke_grant）

**Files:**
- Modify: `src/types/local-bridge.ts`（类型 + BRIDGE_CAPABILITIES + method union）
- Modify: `daemon/src/skill-exec.ts`（把本地 interface 改为从共享源 import）
- Modify: `daemon/src/daemon.ts`（三个 case）
- Modify: `daemon/test/daemon.test.ts`（新 case 的往返）

**Interfaces:**
- Consumes: Task 2 `runSkillScript`；Task 1 `listGrants`/`revokeGrant`。
- Produces: 共享类型 `RunSkillScriptParams` / `RunSkillScriptResult` / `GrantRecord`(wire) / `ListGrantsResult` / `RevokeGrantParams` / `RevokeGrantResult`；capabilities 三项——Task 4 扩展侧依赖。

- [ ] **Step 1: 共享类型**

`src/types/local-bridge.ts`：`BRIDGE_CAPABILITIES` 追加三项，method union 追加三项，并加类型块：

```ts
export const BRIDGE_CAPABILITIES = [
  "run_local_agent",
  "handoff_to_agent",
  "list_agents",
  "run_skill_script",
  "list_grants",
  "revoke_grant",
] as const;
```

```ts
// ── run_skill_script（fs-only 特权路径，Slice 2b）────────────────────────
export interface ScriptPerms {
  fs: boolean;
  network: string[];
}
export interface RunSkillScriptParams {
  skillId: string;
  entry: string;
  /** 扩展从已安装包解析的脚本内容；LLM 传不了。 */
  code: string;
  perms: ScriptPerms;
  input: unknown;
  /** 用户在 HITL 卡批准后重调时置 true（daemon 据此写 grant）。 */
  grantApproved?: boolean;
}
export interface RunSkillScriptResult {
  output: string; // 脚本返回值 JSON string；<untrusted_skill_content> 包裹在扩展侧
  truncated?: boolean;
}
// grant miss → error 通道 { ok:false, error:{ code:"needs_authorization", ... } }

// ── list_grants / revoke_grant（设置页撤销 UI）────────────────────────────
export interface GrantRecord {
  key: string;
  skillId: string;
  entry: string;
  perms: ScriptPerms;
  grantedAt: number;
}
export interface ListGrantsResult {
  grants: GrantRecord[];
}
export interface RevokeGrantParams {
  key: string;
}
export interface RevokeGrantResult {
  revoked: boolean;
}
```

`BridgeRequest.method` union 与 `daemon.ts` 里对应 —— 把 `method` 联合类型加三项：

```ts
export interface BridgeRequest {
  id: string;
  method: "hello" | "run_local_agent" | "handoff_to_agent" | "list_agents" | "run_skill_script" | "list_grants" | "revoke_grant";
  params: unknown;
}
```

- [ ] **Step 2: daemon skill-exec.ts 改 import 共享源**

`daemon/src/skill-exec.ts`：删除本地 `RunSkillScriptParams` / `RunSkillScriptResult` 定义，改为：

```ts
import type { RunSkillScriptParams, RunSkillScriptResult } from "../../src/types/local-bridge";
```

（`ScriptPerms` 现同时存在于 `grants.ts` 与共享源——统一：`grants.ts` 也改为从共享源 import `ScriptPerms`，删除其本地定义，保持单一源。Task 1 的 grants.ts `export interface ScriptPerms` 改为 `export type { ScriptPerms } from "../../src/types/local-bridge"` 或直接 import + re-export。实现者选一种，保证 `daemon/test/grants.test.ts` 的 `import { ..., type ScriptPerms } from "../src/grants"` 仍可用。）

- [ ] **Step 3: Write failing daemon.test 往返**

`daemon/test/daemon.test.ts` 追加（沿用该文件既有 `handleMessage(JSON.stringify(...))` 断言风格——先读该文件现有 test 怎么构造请求/解析响应，照做）:

```ts
test("run_skill_script 无 grant → needs_authorization", async () => {
  const res = JSON.parse(
    await handleMessage(
      JSON.stringify({
        id: "1",
        method: "run_skill_script",
        params: { skillId: "z", entry: "a.js", code: "export default () => 1", perms: { fs: true, network: [] }, input: null },
      }),
    ),
  );
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe("needs_authorization");
});

test("list_grants / revoke_grant 往返（空账本）", async () => {
  const list = JSON.parse(await handleMessage(JSON.stringify({ id: "2", method: "list_grants", params: {} })));
  expect(list.ok).toBe(true);
  expect(Array.isArray(list.result.grants)).toBe(true);
  const rev = JSON.parse(
    await handleMessage(JSON.stringify({ id: "3", method: "revoke_grant", params: { key: "nope" } })),
  );
  expect(rev.ok).toBe(true);
  expect(rev.result.revoked).toBe(false);
});

test("hello capabilities 含新三项", async () => {
  const res = JSON.parse(await handleMessage(JSON.stringify({ id: "4", method: "hello", params: { protocolVersion: 1 } })));
  expect(res.result.capabilities).toContain("run_skill_script");
  expect(res.result.capabilities).toContain("list_grants");
  expect(res.result.capabilities).toContain("revoke_grant");
});
```

> ⚠️ 这些 test 会碰真实 `~/.pie/grants.json`（daemon.ts 的 case 不注入 path）。为避免污染真机账本，实现 Step 4 时 daemon.ts 的三个 case **不传 path**（用默认 `paths.grantsPath`），但 test 里 `run_skill_script` 用一个真机上不存在的 skillId（如 `"z"`）确保走 needs_authorization 分支（不写盘）；`revoke_grant` 用不存在的 key（返回 false，不写盘）；`list_grants` 只读。三个 test 都不产生 grant 写入，安全。若担心真机已有 grants.json，实现者可在 daemon.ts 的 case 里读 `params.grantsPath`（可选、仅测试注入）——但**优先零注入 + 无副作用测试路径**，保持 wire case 纯净。

- [ ] **Step 4: daemon.ts 三个 case**

`daemon/src/daemon.ts`：import 增补，`switch` 加三 case（与既有 case 同构 try/catch）：

```ts
import { runSkillScript } from "./skill-exec";
import { listGrants, revokeGrant } from "./grants";
import type {
  // ...既有
  RunSkillScriptParams,
  ListGrantsResult,
  RevokeGrantParams,
  RevokeGrantResult,
} from "../../src/types/local-bridge";
```

```ts
    case "run_skill_script": {
      try {
        const result = await runSkillScript(msg.params as RunSkillScriptParams);
        return respond({ ok: true, result });
      } catch (e) {
        // needs_authorization / network_not_supported / timeout / script_error 走
        // error.code；扩展据 code 决定弹卡/报错。
        const code = (e as { code?: string }).code ?? "skill_exec_failed";
        log(code === "needs_authorization" ? "info" : "error", "skill.failed", { id, code });
        return respond({ ok: false, error: { code, message: String((e as Error).message ?? e) } });
      }
    }
    case "list_grants": {
      try {
        const result: ListGrantsResult = { grants: listGrants() };
        return respond({ ok: true, result });
      } catch (e) {
        return respond({ ok: false, error: { code: "list_grants_failed", message: String(e) } });
      }
    }
    case "revoke_grant": {
      try {
        const { key } = msg.params as RevokeGrantParams;
        const result: RevokeGrantResult = { revoked: revokeGrant(key) };
        return respond({ ok: true, result });
      } catch (e) {
        return respond({ ok: false, error: { code: "revoke_grant_failed", message: String(e) } });
      }
    }
```

- [ ] **Step 5: Run daemon tests + typecheck**

Run: `cd daemon && bun test`
Expected: PASS（全部含新 3 case + Task1/2）

Run: `pnpm typecheck`（repo root）
Expected: 0 errors（共享类型改动不破坏扩展侧编译）

- [ ] **Step 6: Commit**

```bash
git add src/types/local-bridge.ts daemon/src/skill-exec.ts daemon/src/grants.ts daemon/src/daemon.ts daemon/test/daemon.test.ts
git commit -m "feat(daemon): run_skill_script / list_grants / revoke_grant wire + 共享协议类型"
```

---

### Task 4: 扩展 bridge 请求封装 + error code 透传

**Files:**
- Modify: `src/background/local-bridge.ts`（send 附 code + 三个 request 封装）
- Modify: `src/background/local-bridge.test.ts`（追加——该文件已有 `makeFakePort()` + `vi.resetModules()` + hello-握手 pattern，直接复用）

**Interfaces:**
- Consumes: Task 3 共享类型 + capabilities。
- Produces: `requestSkillScript(params): Promise<{ ok: true; result: RunSkillScriptResult } | { ok: false; needsAuth: boolean; error: string }>`、`requestListGrants(): Promise<GrantRecord[]>`、`requestRevokeGrant(key): Promise<boolean>`、`bridgeHasSkillScript(): boolean`——Task 5/7 依赖。

- [ ] **Step 1: send 附 error code**

`src/background/local-bridge.ts` 的 `onMessage` reject 分支：

```ts
    if (msg.ok) p.resolve(msg.result);
    else {
      const err = new Error(msg.error.message);
      (err as Error & { code?: string }).code = msg.error.code;
      p.reject(err);
    }
```

- [ ] **Step 2: Write failing tests**（`src/background/local-bridge.test.ts` 追加；复用文件顶部 `makeFakePort()`——`initLocalBridge()` → 抓 hello 请求 `postMessage.mock.calls[0][0]` → `fakePort._emit` 回 hello 响应带 `capabilities: ["run_skill_script","list_grants","revoke_grant"]` → `await Promise.resolve()` flush microtask 使 ready=true → 再调 `requestSkillScript(...)`，抓第二条 postMessage 的 id，`_emit` 回响应）

每条一个 test：
- `requestSkillScript` 成功（daemon 回 `{ok:true, result:{output}}`）→ 解析成 `{ ok: true, result }`
- daemon 回 `{ok:false, error:{code:"needs_authorization", message}}` → `{ ok: false, needsAuth: true, error }`（**不 throw**）
- daemon 回 `{ok:false, error:{code:"script_error", message}}` → `{ ok: false, needsAuth: false, error }`
- `bridgeHasSkillScript()`：hello 带该 capability → true；不带 → false
- `requestListGrants()` → 解析 `result.grants`；无 `list_grants` capability → `[]`（零 wire）
- `requestRevokeGrant(key)` → 解析 `result.revoked`；无 capability → `false`

写法：请求发出后（`requestSkillScript` 返回 pending promise），从 `fakePort.postMessage.mock.calls` 找到该请求的 id，`fakePort._emit({ id, ok:..., ... })`，`await` 该 promise 断言。

- [ ] **Step 3: Implement**

`src/background/local-bridge.ts` 追加（import 补齐共享类型）：

```ts
export function bridgeHasSkillScript(): boolean {
  return capabilities.includes("run_skill_script");
}

export async function requestSkillScript(
  params: RunSkillScriptParams,
): Promise<
  | { ok: true; result: RunSkillScriptResult }
  | { ok: false; needsAuth: boolean; error: string }
> {
  try {
    const r = (await send("run_skill_script", params)) as RunSkillScriptResult;
    return { ok: true, result: r };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { ok: false, needsAuth: code === "needs_authorization", error: (e as Error).message };
  }
}

export async function requestListGrants(): Promise<GrantRecord[]> {
  if (!capabilities.includes("list_grants")) return [];
  const r = (await send("list_grants", {})) as ListGrantsResult;
  return r.grants;
}

export async function requestRevokeGrant(key: string): Promise<boolean> {
  if (!capabilities.includes("revoke_grant")) return false;
  const r = (await send("revoke_grant", { key })) as RevokeGrantResult;
  return r.revoked;
}
```

`BridgeRequest["method"]` 已在 Task 3 加了三项，`send` 的 method 参数类型自动放行。

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run src/background/local-bridge` 及 `pnpm typecheck`
Expected: PASS / 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/background/local-bridge.ts src/background/local-bridge*.test.ts
git commit -m "feat(bg): requestSkillScript(needsAuth 判别)/requestListGrants/requestRevokeGrant + send 透传 error code"
```

---

### Task 5: run_skill_script 工具 — 特权路由 + 授权卡往返

**Files:**
- Modify: `src/lib/agent/tools/skill-script.ts`（privileged 分支）
- Modify: `src/lib/agent/tools/skill-script.test.ts`（新分支测试）
- Modify: `src/lib/panel-request.ts`（`skill-grant` kind）
- Modify: `src/lib/agent/loop.ts`（工具装配注入新 deps）

**Interfaces:**
- Consumes: Task 1/skills `parseScriptDecls`/`findScriptDecl`/`isPureCompute`（2a 已有）；Task 4 `requestSkillScript`/`bridgeHasSkillScript`；`getEnabledSkillPackages`（2b 前置项）；`requestFromPanel`（loop 侧）。
- Produces: `buildRunSkillScriptTool` 扩展 deps `{ runInSandbox; runPrivileged?; requestGrantConsent?; isSkillEnabled? }`；`PanelRequestMap["skill-grant"]`。

- [ ] **Step 1: panel-request kind**

`src/lib/panel-request.ts` 的 `PanelRequestMap` 加：

```ts
  "skill-grant": {
    req: { skillId: string; skillName: string; entry: string; perms: { fs: boolean; network: string[] } };
    res: boolean; // true = 批准
  };
```

- [ ] **Step 2: Write failing tests**（skill-script.test.ts 追加——沿用 2a 文件顶部既有的 `vi.hoisted`/`vi.mock("../../skills")` + `PKG` fixture；privileged 分支用注入 deps 测，不碰真模块）

在 2a 的 `PKG` fixture 里，`scripts/fetch.js` 已是 network 声明；再加一个 fs-only 声明脚本。追加 fixture 顶部：

```ts
const FS_PKG: SkillPackage = {
  ...PKG,
  frontmatter: {
    ...PKG.frontmatter,
    capabilities: {
      scripts: ["scripts/dedupe.js", '{"entry": "scripts/save.js", "fs": true}', '{"entry": "scripts/fetch.js", "network": ["api.example.com"]}'],
    },
  },
  files: { ...PKG.files, "scripts/save.js": "export default (i) => i;" },
};

function makePrivileged(over: Partial<import("./skill-script").SkillScriptDeps> = {}) {
  const runPrivileged = vi.fn(async () => ({ ok: true, result: { output: '{"saved":true}' } }) as
    | { ok: true; result: { output: string; truncated?: boolean } }
    | { ok: false; needsAuth: boolean; error: string });
  const requestGrantConsent = vi.fn(async () => true);
  const isSkillEnabled = vi.fn(async () => true);
  const runInSandbox = vi.fn(async () => '"sandbox"');
  const tool = buildRunSkillScriptTool({ runInSandbox, runPrivileged, requestGrantConsent, isSkillEnabled, skillName: async () => "CSV", ...over });
  return { tool, runPrivileged, requestGrantConsent, isSkillEnabled, runInSandbox };
}
```

断言（每条 fixture 用 `resolveSkillPackage.mockResolvedValue(FS_PKG)`）：

```ts
describe("run_skill_script — fs-only 特权（2b）", () => {
  beforeEach(() => resolveSkillPackage.mockResolvedValue(FS_PKG));

  it("grant 已存在（runPrivileged 直接 ok）→ observation 包 untrusted，未走 sandbox", async () => {
    const { tool, runPrivileged, requestGrantConsent, runInSandbox } = makePrivileged();
    const r = await tool.handler({ skillId: "csv-utils", entry: "scripts/save.js", input: { a: 1 } }, ctx);
    expect(r.success).toBe(true);
    expect(r.observation).toContain("<untrusted_skill_content>");
    expect(r.observation).toContain('{\\"saved\\":true}'.replace(/\\\\/g, "")); // '{"saved":true}' escaped 视 escapeUntrustedWrappers 实际行为，核心断言下一行
    expect(runPrivileged).toHaveBeenCalledTimes(1);
    expect(requestGrantConsent).not.toHaveBeenCalled();
    expect(runInSandbox).not.toHaveBeenCalled(); // 特权走 daemon 非 sandbox
  });

  it("needsAuth → 弹卡批准 → 二调带 grantApproved:true", async () => {
    let first = true;
    const runPrivileged = vi.fn(async (p: { grantApproved?: boolean }) => {
      if (first) { first = false; return { ok: false as const, needsAuth: true, error: "auth" }; }
      return { ok: true as const, result: { output: '"ok"' } };
    });
    const { tool, requestGrantConsent } = makePrivileged({ runPrivileged });
    const r = await tool.handler({ skillId: "csv-utils", entry: "scripts/save.js" }, ctx);
    expect(r.success).toBe(true);
    expect(requestGrantConsent).toHaveBeenCalledTimes(1);
    expect(runPrivileged).toHaveBeenCalledTimes(2);
    expect((runPrivileged.mock.calls[1][0] as { grantApproved?: boolean }).grantApproved).toBe(true);
  });

  it("拒绝授权 → declined，不二调", async () => {
    const runPrivileged = vi.fn(async () => ({ ok: false as const, needsAuth: true, error: "auth" }));
    const { tool } = makePrivileged({ runPrivileged, requestGrantConsent: vi.fn(async () => false) });
    const r = await tool.handler({ skillId: "csv-utils", entry: "scripts/save.js" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/declined/i);
    expect(runPrivileged).toHaveBeenCalledTimes(1);
  });

  it("network 声明 → privileged_script 指向后续版本，不碰 daemon", async () => {
    const { tool, runPrivileged } = makePrivileged();
    const r = await tool.handler({ skillId: "csv-utils", entry: "scripts/fetch.js" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^privileged_script:/);
    expect(runPrivileged).not.toHaveBeenCalled();
  });

  it("skill 未启用 → 拒绝（2b 前置项），不碰 daemon", async () => {
    const { tool, runPrivileged } = makePrivileged({ isSkillEnabled: vi.fn(async () => false) });
    const r = await tool.handler({ skillId: "csv-utils", entry: "scripts/save.js" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not enabled/i);
    expect(runPrivileged).not.toHaveBeenCalled();
  });

  it("无 daemon deps（纯计算-only 装配）→ fs 脚本报「需要本地组件」", async () => {
    const tool = buildRunSkillScriptTool({ runInSandbox: vi.fn(async () => '"x"') });
    const r = await tool.handler({ skillId: "csv-utils", entry: "scripts/save.js" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/privileged_script:.*local daemon/i);
  });

  it("纯计算路径回归：仍走 runInSandbox（2a 行为不变）", async () => {
    const { tool, runInSandbox, runPrivileged } = makePrivileged();
    const r = await tool.handler({ skillId: "csv-utils", entry: "scripts/dedupe.js" }, ctx);
    expect(r.success).toBe(true);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
    expect(runPrivileged).not.toHaveBeenCalled();
  });
});
```

（`observation` 里 output 的精确转义形态以 `escapeUntrustedWrappers` 实际行为为准——首条测试的第 4 行断言若与真实转义不符则删该行，保留 `toContain("<untrusted_skill_content>")` 与「未走 sandbox」两条硬断言。）

- [ ] **Step 3: Implement 工具分支**

`src/lib/agent/tools/skill-script.ts`：deps 扩展 + privileged 分支替换 2a 的 blanket privileged 错误。

```ts
export interface SkillScriptDeps {
  runInSandbox: (code: string, input: unknown) => Promise<string>;
  /** fs-only 特权路径：调 daemon。缺省（无 daemon 能力）→ 特权脚本报「需要本地组件」。 */
  runPrivileged?: (params: {
    skillId: string;
    entry: string;
    code: string;
    perms: { fs: boolean; network: string[] };
    input: unknown;
    grantApproved?: boolean;
  }) => Promise<
    { ok: true; result: { output: string; truncated?: boolean } } | { ok: false; needsAuth: boolean; error: string }
  >;
  /** HITL 卡：展示 perms 原文，返回是否批准。 */
  requestGrantConsent?: (p: { skillId: string; skillName: string; entry: string; perms: { fs: boolean; network: string[] } }) => Promise<boolean>;
  /** 2b 前置项：skill 是否已启用（禁用 skill 的脚本不放行 daemon 执行）。 */
  isSkillEnabled?: (skillId: string) => Promise<boolean>;
  /** skill 展示名（授权卡用）。缺省用 skillId。 */
  skillName?: (skillId: string) => Promise<string>;
}
```

privileged 分支（替换 2a 里 `if (!isPureCompute(decl)) { return privileged_script error }`）：

```ts
      if (!isPureCompute(decl)) {
        // network 声明 → 2c，不在 2b 执行（sandbox-exec 做不到 per-domain）
        if (decl.network.length > 0) {
          return {
            success: false,
            error:
              `privileged_script: ${decl.entry} declares network access, which is not available yet ` +
              `(planned for a later release). Only filesystem-capable scripts can run today.`,
          };
        }
        // fs-only：走 daemon。无 daemon 能力 → 结构化「需要本地组件」。
        if (!deps.runPrivileged || !deps.requestGrantConsent) {
          return {
            success: false,
            error:
              `privileged_script: ${decl.entry} needs the Pie local daemon to run (filesystem access). ` +
              `Install/enable the local bridge in Settings.`,
          };
        }
        // 2b 前置项：禁用 skill 不放行
        if (deps.isSkillEnabled && !(await deps.isSkillEnabled(a.skillId))) {
          return { success: false, error: `Skill ${a.skillId} is not enabled; enable it before running its scripts.` };
        }
        const perms = { fs: decl.fs, network: decl.network };
        let res = await deps.runPrivileged({ skillId: a.skillId, entry: decl.entry, code, perms, input: a.input });
        if (!res.ok && res.needsAuth) {
          const skillName = deps.skillName ? await deps.skillName(a.skillId) : a.skillId;
          const approved = await deps.requestGrantConsent({ skillId: a.skillId, skillName, entry: decl.entry, perms });
          if (!approved) return { success: false, error: "User declined the skill script authorization." };
          res = await deps.runPrivileged({ skillId: a.skillId, entry: decl.entry, code, perms, input: a.input, grantApproved: true });
        }
        if (!res.ok) {
          return { success: false, error: `run_skill_script failed: ${res.error}` };
        }
        return {
          success: true,
          observation: `<untrusted_skill_content>${escapeUntrustedWrappers(res.result.output)}</untrusted_skill_content>`,
        };
      }
```

- [ ] **Step 4: 把 run_skill_script 从静态注册挪成 loop 装配（授权卡要 sessionId，ctx 不带）**

`ToolHandlerContext` 无 `sessionId`（已核实），授权卡 `requestFromPanel(sessionId, ...)` 只能在 loop 闭包装配——照 `run_local_agent`/`handoff_to_agent` 先例（它们在 `LOCAL_BRIDGE_TOOL_NAMES`、**不**在 `KNOWN_BUILT_IN_TOOL_NAMES`、**不**在 `BUILT_IN_TOOLS`，只在 `TOOL_CLASSES`+`TOOL_GROUPS`）。把 `run_skill_script` 对齐这个形态：

**改动 1 — `src/lib/agent/tool-names.ts`**：从 `SKILL_MEDIATION_TOOL_NAMES` 删掉 `"run_skill_script"`（这样它离开 `KNOWN_BUILT_IN_TOOL_NAMES`）。`TOOL_CLASSES` 的 `run_skill_script: "write"` 与 `TOOL_GROUPS` 的 `run_skill_script: "skill-mediation"` **保留**（loop-assembled 工具在这两张表有条目、不在 KNOWN 列表——`run_local_agent` 就是这样，无 build-time 冲突）。同步该数组上方注释（2a 提 run_skill_script 的那句移到说明它现在是 loop-assembled）。

**改动 2 — `src/lib/agent/tools.ts`**：删掉 `import { RUN_SKILL_SCRIPT_TOOL }` 与 `BUILT_IN_TOOLS` 里的 `RUN_SKILL_SCRIPT_TOOL,` 行。

**改动 3 — `src/lib/agent/tools/skill-script.ts`**：删掉文件末尾的 `export const RUN_SKILL_SCRIPT_TOOL = ...`（静态实例不再需要——loop 统一 build）。

**改动 4 — `src/lib/agent/loop.ts`**：在工具装配区（`localBridgeTools` 附近），**无条件**加一个 `run_skill_script`（纯计算路径不依赖 daemon，必须常在），privileged deps 仅在桥就绪且声明能力时注入。import 补齐 `buildRunSkillScriptTool` / `bridgeHasSkillScript` / `requestSkillScript` / `getEnabledSkillPackages` / `resolveSkillPackage`（若未 import）：

```ts
const skillScriptTool = buildRunSkillScriptTool({
  runInSandbox: (code, input) => sendToOffscreen<string>({ type: "skill:run_script", code, input }),
  // fs-only 特权 deps 仅在桥就绪 + 声明 run_skill_script 能力时注入；
  // 否则 undefined → fs 脚本报「需要本地组件」，纯计算脚本照常走 sandbox。
  ...(isBridgeReady() && bridgeHasSkillScript()
    ? {
        runPrivileged: (p) => requestSkillScript(p),
        requestGrantConsent: (p) => requestFromPanel(sessionId, "skill-grant", p),
        isSkillEnabled: async (id) => (await getEnabledSkillPackages()).some((pkg) => pkg.id === id),
        skillName: async (id) => (await resolveSkillPackage(id))?.frontmatter.name ?? id,
      }
    : {}),
});
```

把 `skillScriptTool` 加进 `fullToolList`（在 2a 原来 `RUN_SKILL_SCRIPT_TOOL` 所在的相对位置，即 `...SKILL_ACCESS_TOOLS` 之后那类 skill-mediation 工具区；它现在是变量而非静态常量）。**验证**：`run_skill_script` 仍出现在最终 tool 列表（无 daemon 时也在，只是特权 deps 缺省）——`pnpm test` 的 disclosure/parity 测试守着（KNOWN 列表已不含它，故 parity 不再要求它进 BUILT_IN_TOOLS；`getToolGroup("run_skill_script")` 仍解析到 `skill-mediation`）。

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run src/lib/agent/tools/skill-script.test.ts && pnpm test && pnpm typecheck`
Expected: PASS（新分支 + 2a 回归全绿）；panel-request kind 编译期校验过。

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/tools/skill-script.ts src/lib/agent/tools/skill-script.test.ts src/lib/panel-request.ts src/lib/agent/loop.ts src/lib/agent/tools.ts
git commit -m "feat(agent): run_skill_script fs-only 特权路由——enabled 门禁 + daemon 往返 + skill-grant 授权卡"
```

---

### Task 6: SkillGrantCard 授权卡 + Chat 渲染 + i18n

**Files:**
- Create: `src/sidepanel/components/SkillGrantCard.tsx`
- Create: `src/sidepanel/components/SkillGrantCard.test.tsx`
- Modify: `src/sidepanel/components/Chat.tsx`（render 分支）
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts`（`skillGrant.*`）

**Interfaces:**
- Consumes: Task 5 `PanelRequestMap["skill-grant"]` 的 req 形状。
- Produces: `SkillGrantCard`。

- [ ] **Step 1: Write failing test**（RTL，房内 `afterEach(() => cleanup())`，无 jest-dom → `.toBeTruthy()`；mock `useT` 返回 key 或用真字典）

断言：
- 渲染 skillName + entry + perms 原文（fs → 显示「文件读写」类文案；network 数组为空 2b 不显示 network 行）
- 点允许 → `onDecision(true)`；点拒绝 → `onDecision(false)`

- [ ] **Step 2: Implement 卡片**（镜像 HandoffCard 的 warning 样式 + semanticsNote pattern）

`src/sidepanel/components/SkillGrantCard.tsx`：

```tsx
import { useT } from "@/lib/i18n";

interface Props {
  payload: { skillId: string; skillName: string; entry: string; perms: { fs: boolean; network: string[] } };
  onDecision: (approved: boolean) => void;
}

/**
 * Authorization gate before a skill's privileged (filesystem) script runs on the
 * local daemon. Perms are shown verbatim (spec §6.1: write-class local actions
 * have no silent path). Approving persists a grant keyed by skill + perms + script
 * content hash — a code change re-prompts.
 */
export function SkillGrantCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("skillGrant.title")}</div>
      <div className="text-[12px] leading-relaxed text-warning/70">{t("skillGrant.semanticsNote")}</div>
      <div>
        <div className="text-warning/70">{t("skillGrant.skillLabel")}</div>
        <div className="mt-1 text-warning">{payload.skillName}</div>
      </div>
      <div>
        <div className="text-warning/70">{t("skillGrant.scriptLabel")}</div>
        <code className="mt-1 block break-all rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning">
          {payload.entry}
        </code>
      </div>
      <div>
        <div className="text-warning/70">{t("skillGrant.permsLabel")}</div>
        <ul className="mt-1 list-disc pl-4 text-warning">
          {payload.perms.fs && <li>{t("skillGrant.permFs")}</li>}
        </ul>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecision(true)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("skillGrant.allow")}
        </button>
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("skillGrant.deny")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Chat.tsx render 分支**（在 `handoff-to-agent` 分支后加，import SkillGrantCard）：

```tsx
      {panelRequest?.kind === "skill-grant" && (
        <SkillGrantCard
          payload={
            panelRequest.payload as {
              skillId: string;
              skillName: string;
              entry: string;
              perms: { fs: boolean; network: string[] };
            }
          }
          onDecision={(approved) => respondPanel(panelRequest.requestId, { ok: true, data: approved })}
        />
      )}
```

- [ ] **Step 4: i18n（6 字典 parity，`skillGrant` 块）**

en.ts：
```ts
    skillGrant: {
      title: "Allow this skill to run a local script?",
      semanticsNote: "The script runs on your machine with filesystem access, in an isolated workspace.",
      skillLabel: "Skill",
      scriptLabel: "Script",
      permsLabel: "Requested access",
      permFs: "Read and write files in the skill's workspace",
      allow: "Allow",
      deny: "Deny",
    },
```
zh-CN.ts：
```ts
    skillGrant: {
      title: "允许该 skill 运行本地脚本？",
      semanticsNote: "脚本将在你机器上以文件系统权限运行，限于隔离的工作目录。",
      skillLabel: "Skill",
      scriptLabel: "脚本",
      permsLabel: "请求的权限",
      permFs: "在 skill 工作目录内读写文件",
      allow: "允许",
      deny: "拒绝",
    },
```
其余四门（zh-TW / es-419 / ja / pt-BR）按各语言翻译补齐同结构（键必须与 en 完全一致，否则字典 parity 测试挂）。

- [ ] **Step 5: Run tests + typecheck + build**

Run: `pnpm vitest run src/sidepanel/components/SkillGrantCard.test.tsx && pnpm test && pnpm typecheck && pnpm build`
Expected: PASS（含 i18n parity 测试）/ 0 errors / build ✓

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/SkillGrantCard.tsx src/sidepanel/components/SkillGrantCard.test.tsx src/sidepanel/components/Chat.tsx src/lib/i18n/dictionaries/
git commit -m "feat(panel): SkillGrantCard 授权卡（perms 原文）+ Chat 渲染 + i18n 6 字典"
```

---

### Task 7: 设置页 grants 撤销 UI + 后台 handler

**Files:**
- Modify: `src/background/index.ts`（`skill-grants:list` / `skill-grants:revoke` handler）
- Modify: `src/sidepanel/components/Settings.tsx`（LocalBridgeSection 加 grants 列表）
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts`（`settings.localBridge.grants*`）
- Modify: `CLAUDE.md`（skills / daemon 一节补 2b）

**Interfaces:**
- Consumes: Task 4 `requestListGrants`/`requestRevokeGrant`。
- Produces: 无新导出（UI + message handler）。

- [ ] **Step 1: 后台 handler**（镜像 `local-agents:list`/`toggle`，桥没 ready → 空/false）

`src/background/index.ts` 追加（import `requestListGrants`/`requestRevokeGrant`）：

```ts
  if (message?.type === "skill-grants:list") {
    (async () => {
      if (!isBridgeReady()) return { grants: [] };
      return { grants: await requestListGrants() };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ grants: [] }));
    return true;
  }

  if (message?.type === "skill-grants:revoke") {
    const m = message as { type: string; key: string };
    (async () => {
      if (!isBridgeReady()) return { ok: false };
      return { ok: await requestRevokeGrant(m.key) };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
```

- [ ] **Step 2: Write failing test**（Settings LocalBridgeSection 的 grants 渲染——RTL，mock `chrome.runtime.sendMessage` 对 `skill-grants:list` 返回 1 条 grant，断言 skillId + entry 渲染 + 撤销按钮触发 `skill-grants:revoke`）

沿用该文件既有 test pattern；若 Settings.test 结构复杂，最小化为针对 grants 子区的行为断言。

- [ ] **Step 3: Settings UI**

`LocalBridgeSection` 内加 grants state + 查询（零轮询，`status?.ready` flip 时查，撤销后重查）+ 渲染。放在 agents 列表块之后：

```tsx
  const [grants, setGrants] = useState<{ key: string; skillId: string; entry: string }[]>([]);
  useEffect(() => {
    if (status?.ready) queryGrants(setGrants);
    else setGrants([]);
  }, [status?.ready]);
  const onRevoke = (key: string) => {
    try {
      chrome.runtime.sendMessage({ type: "skill-grants:revoke", key }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.ok) queryGrants(setGrants);
      });
    } catch { /* noop */ }
  };
```

（`queryGrants` 顶层 helper 镜像 `queryLocalAgents`：`sendMessage({type:"skill-grants:list"}, res => cb(res?.grants ?? []))`。）

渲染块（`status?.ready && grants.length > 0` 时）：标题 `t("settings.localBridge.grantsTitle")`，每行 `skillId · entry` + 撤销按钮 `t("settings.localBridge.grantRevoke")`。样式沿用 agents 行。

- [ ] **Step 4: i18n（`settings.localBridge` 加 3 键）**

en：`grantsTitle: "Authorized skill scripts"`, `grantRevoke: "Revoke"`, `grantsEmpty` 可不加（空列表不渲染）。zh-CN：`grantsTitle: "已授权的 skill 脚本"`, `grantRevoke: "撤销"`。其余四门补齐。

- [ ] **Step 5: CLAUDE.md**

`src/lib/skills/` 一节补一句：特权脚本（fs 声明）经 daemon 执行（`sandbox-exec` 隔离 + `skill:<id>:<permsHash>` 持久 grant，permsHash 含脚本内容 hash → 改代码重弹卡；网络能力 Slice 2c）。
Architecture Invariants 或 daemon 相关处补一句：grants 账本 daemon 独占（`~/.pie/grants.json`），扩展零 grant 存储，撤销走设置页「本地打通」→ daemon 删条目；audit `~/.pie/logs/audit.jsonl`。

- [ ] **Step 6: 全量验证**

```bash
cd daemon && bun test && cd .. && pnpm test && pnpm typecheck && pnpm build
```
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/background/index.ts src/sidepanel/components/Settings.tsx src/lib/i18n/dictionaries/ CLAUDE.md
git commit -m "feat(settings): grants 撤销 UI + 后台 handler；docs: 特权脚本 daemon 路径 + grants 账本"
```

---

## 真机测试清单（PR body 用）

前置：daemon 需重编译 + 热替换（`cd daemon && bun run compile` → `rm ~/.pie/bin/pie && cp <out> ~/.pie/bin/pie`（换 inode，别 cp 覆盖同 inode）→ `launchctl kickstart -k gui/$(id -u)/ai.wiseria.pie`）；扩展主目录 `pnpm build` + `chrome://extensions` 刷新。

1. **首次授权往返**：建带 `capabilities.scripts: [{"entry":"scripts/save.js","fs":true}]` 的测试 skill（脚本 `export default (i) => { require("fs").writeFileSync("out.txt", JSON.stringify(i)); return {saved:true}; }`），启用它 → 让助手跑 → **弹 SkillGrantCard 显示 perms 原文** → 允许 → 返回 `{saved:true}`，`~/.pie/skills/<id>/workspace/out.txt` 存在。
2. **grant 记住**：同脚本再跑一次 → **不再弹卡**，直接执行。
3. **改代码重弹**：编辑脚本内容 → 再跑 → **重新弹卡**（permsHash 含代码 hash）。
4. **拒绝**：跑另一个 fs 脚本 → 卡上点拒绝 → 报 declined，脚本没执行。
5. **fs 隔离**：脚本试写 workspace 外（`require("fs").writeFileSync("/tmp/escape.txt","x")`）→ 脚本报错（sandbox-exec 拒），`/tmp/escape.txt` 不存在。
6. **network 挡在 2b 外**：`{"entry":..., "network":["x.com"]}` 声明 → 报 `privileged_script:` 指向后续版本，不弹卡不执行。
7. **禁用 skill 不放行**：把 skill 禁用后跑其脚本 → 拒绝（2b 前置项）。
8. **超时**：`export default () => { while(true){} }` → 约 60s 后报 timeout。
9. **撤销 UI**：设置页「本地打通」→ 已授权列表显示步骤 1 的 grant → 撤销 → 再跑步骤 1 脚本 → **重新弹卡**。
10. **audit**：`~/.pie/logs/audit.jsonl` 每次执行有一行。
11. **纯计算回归**（2a）：纯计算脚本仍走 sandbox（不弹卡、不碰 daemon）。
12. **daemon 未装降级**：关掉本地打通 → 特权脚本报「需要本地组件」，纯计算脚本仍工作。

## Follow-up

- **Slice 2c**：network 能力 + SSRF/exfil 威胁建模 + 强制模型选型（诚实层 vs 双进程代理）。
- 脚本 authoring 缺口（create_skill/编辑 UI 塞不进 scripts/*.js）——2a 已知，脚本作者路径待后续。
- `.runs/` scratch 清理靠 finally rmSync；若 daemon 崩在执行中会留残——低频，可选加启动期清扫。
