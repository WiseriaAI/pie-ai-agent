# Skill 体系（有本地 daemon）— Slice 1：daemon skill-fs 地基 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 daemon 以 `~/.pie/skills/<name>/` 为真源，提供 skill 的列举/读文件/落盘/删除/**在 srt 沙箱里跑脚本**/grant 授权账本/审计，并经桥声明 `skill_fs` 能力——扩展侧改造（Slice 2）与授权卡/迁移/设置页（Slice 3）在此之上再做。

**Architecture:** 纯 daemon 侧 Bun/TypeScript。skill 存磁盘、SKILL.md 对齐 Anthropic Agent Skills 标准 frontmatter。执行经一层 **Pie 自有 `SkillSandbox` 接口**（Task 1 spike 定后端：优先 `@anthropic-ai/sandbox-runtime` 的 `SandboxManager`，塞不进 bun 二进制则回退 2b 已验证的手写 `sandbox-exec` profile + 声明域名走代理）——把 srt「research preview」的不稳定挡在接口后，且让编排逻辑用注入 fake 单测、真强制走真机。grant 按「能力信封」记（不哈希脚本字节），daemon 独占 `~/.pie/grants.json`。

**Tech Stack:** Bun（`bun test`、`bun build --compile`）、`@anthropic-ai/sandbox-runtime`（Apache-2.0，Task 1 定夺）、`yaml`（frontmatter 解析）、Unix domain socket NDJSON 桥（现状）。

## Slice 路线（本 plan 只覆盖 Slice 1）

1. **Slice 1（本 plan）**：daemon skill-fs 地基——磁盘真源 + srt 执行 + grant/audit + 桥方法 + `skill_fs` capability。独立可测（`bun test` + 真机 srt 强制清单）。
2. **Slice 2（待写）**：扩展 `SkillSource` 抽象（`IdbSkillSource`/`DaemonSkillSource` + builtin 只读层）、桥客户端、模式判定、把现有 skill mediation 工具接到 active source。
3. **Slice 3（待写）**：授权卡按 per-skill 信封重做、IDB→磁盘迁移、设置页 grant 列举/撤销。

> Slice 2/3 消费的桥接口在本 plan §Global Constraints 与 Task 2 类型里锁定；其精确 TDD 代码等 Slice 1 真实落地后再写，避免对着未落地接口写投机代码。

---

## Global Constraints

每个 task 的要求都隐含以下全项（值逐字取自 spec `docs/specs/2026-07-10-skill-system-with-local-daemon.md`）：

- **协议只增不改**：`PROTOCOL_VERSION` 保持 `1`；新增 capability 字面量 `"skill_fs"`；新方法全加法。破坏性变更才 bump（不在本 slice）。
- **`src/types/local-bridge.ts` 是协议唯一权威源**，daemon 相对 import，不复制类型定义。
- **grant 身份 = skill 名 + 能力信封**（`allowedDomains` + `extraWrites` + `runnableScripts` 三者规范化），**不哈希脚本字节**。信封变才重弹。
- **daemon 独占 grant 账本** `~/.pie/grants.json`（原子写 temp+rename）；扩展零 grant 存储。
- **`entry` 必须 ∈ 该 skill `scripts/` 目录列举集**，否则拒——LLM 传不进代码，daemon 只跑自己磁盘上的文件。
- **默认沙箱基线**：写只准 `<skillDir>/workspace/`（`SKILL.md`/`scripts/`/`references/` 不可写）；网络 `allowedDomains: []` 默认全断；读默认开但 `denyRead` 敏感目录（`~/.ssh`/`~/.aws`/`~/.gnupg`/`~/.pie/grants.json`/`~/.pie/logs`）。声明的 `metadata.pie.network`/`write` 经 grant 批准后并进 settings 放行。
- **srt 挡在 Pie 自有 `SkillSandbox` 接口后**：vendor-lock 具体版本；编排逻辑注入 fake sandbox 单测，真强制走真机清单。
- **skill 名 = 目录名 = id**：kebab-case，正则 `^[a-z0-9][a-z0-9-]*$`；任何 name/path 入参在 `join` 前过遍历校验（拒 `.`/`..`/路径分隔符/全点号）。
- **audit best-effort**：`~/.pie/logs/audit.jsonl` 写失败绝不阻断执行。
- **socket `0600`**（现状不动）；native host `allowed_origins` 锁扩展 ID（现状不动）。
- **daemon dispatch 每个 case 必须 try/catch 对称**（见 `daemon.ts` 现有 `list_agents` 注释：抛异常会让工具永久挂起）。
- **测试**：daemon 用 `bun test`（`import { test, expect } from "bun:test"`），hermetic（`setLogEnabled(false)` + 注入临时目录，不碰真实 `~/.pie`）。

---

## File Structure

- `src/types/local-bridge.ts` — **修改**：加 `skill_fs` capability + 7 组 skill_fs 方法的 params/result 类型 + 扩展 `BridgeRequest["method"]` 联合。
- `daemon/src/paths.ts` — **修改**：加 `skillsDir`/`grantsPath`/`auditPath`。
- `daemon/src/skill-md.ts` — **新建**：SKILL.md 标准 frontmatter 读取（`yaml` 依赖），产出 `{name, description, declaredCaps}` + body。
- `daemon/src/skill-store.ts` — **新建**：`listSkills()`/`readSkillFile()`/`writeSkill()`/`deleteSkill()`；skill 名校验；`scripts/` 列举。
- `daemon/src/skill-sandbox.ts` — **新建（Task 1 spike 产出）**：`SkillSandbox` 接口 + `realSkillSandbox`（srt 或回退后端）+ `fakeSkillSandbox`（测试用）。
- `daemon/src/grants.ts` — **新建**（2b 同名文件重写为 per-skill 信封版）：`GrantEnvelope`/`grantKey`/`hasGrant`/`putGrant`/`listGrants`/`revokeGrant`。
- `daemon/src/audit.ts` — **新建**（2b 脊柱平移）：`appendAudit` best-effort。
- `daemon/src/skill-exec.ts` — **新建**：`runSkillScript()` 编排——resolve dir、entry 校验、加载 declaredCaps、grant 门禁、组装 sandbox settings、经注入的 `SkillSandbox` 跑、审计、错误映射。
- `daemon/src/daemon.ts` — **修改**：dispatch 加 7 个 case（try/catch 对称）+ `hello` 广播 `skill_fs`。
- `daemon/package.json` — **修改**：加 `yaml` + `@anthropic-ai/sandbox-runtime` 依赖（后者由 Task 1 定夺是否库内嵌）。
- 各 `daemon/test/*.test.ts` — 对应新建。

---

### Task 1: Spike — `SkillSandbox` 后端（GATE）

> 这是含真实不确定性的调查任务，产出**可用代码 + 决策记录 + 真机验证清单**，不是纯设计。后续 Task 6/8 消费它定义的 `SkillSandbox` 接口。**未过本 task 不进 Task 2。**

**Files:**
- Create: `daemon/src/skill-sandbox.ts`
- Create: `daemon/test/skill-sandbox.test.ts`（只测接口契约 + `fakeSkillSandbox`，不测真强制）
- Modify: `daemon/package.json`（若 srt 库内嵌成功则加 `@anthropic-ai/sandbox-runtime`）
- Create: `docs/plans/2026-07-10-skill-daemon-fs-foundation.spike.md`（决策记录）

**Interfaces:**
- Produces（后续任务依赖的精确契约，无论内部选哪个后端都不变）：
  ```ts
  export interface SandboxSettings {
    /** 绝对路径白名单，只有这些子树可写（基线含 <skillDir>/workspace） */
    allowWrite: string[];
    /** 允许出口的域名；空 = 全断 */
    allowedDomains: string[];
    /** 拒读的绝对路径（敏感目录） */
    denyRead: string[];
  }
  export interface SandboxRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    truncated: boolean;
  }
  export interface SkillSandbox {
    /** 在 settings 约束下跑 argv（argv[0] 是解释器绝对路径）。cwd/env 由调用方给。 */
    run(
      argv: string[],
      cwd: string,
      env: Record<string, string>,
      settings: SandboxSettings,
    ): Promise<SandboxRunResult>;
  }
  export const realSkillSandbox: SkillSandbox;   // 真后端（srt 或回退）
  export function fakeSkillSandbox(
    impl: (argv: string[], cwd: string, env: Record<string, string>, settings: SandboxSettings) => Promise<SandboxRunResult>,
  ): SkillSandbox;                                // 测试注入用
  ```

**调查问题（决策记录必须逐条回答）：**

1. `@anthropic-ai/sandbox-runtime` 的 `SandboxManager` 能否被 `bun build --compile` 打进 `dist/pie` 独立二进制并在运行期工作？（srt 文档称需 Node/npm——验证 bun 内嵌 or 需要外部 node）
2. srt 在 macOS 的网络过滤靠独立代理进程 + `sandbox-exec`——这些辅助进程/二进制（含 `ripgrep`）在编译后的 pie 二进制运行环境里可得吗？需要捆绑还是探测系统安装？
3. 若 1/2 任一为否 → **回退后端**：复用 2b 已真机验证的手写 `sandbox-exec` profile（`daemon/src/skill-exec.ts` on `feat/skill-scripts-daemon` 的 `buildSandboxProfile`/`realSkillSpawn`）做「写限子树 + 默认断网 + 敏感读拒」；声明域名的网络放行推迟到 2c 或用最小自建代理。回退后端同样实现上面的 `SkillSandbox` 接口。

- [ ] **Step 1: 起一个最小 srt 内嵌 spike**

在 `daemon/` 下 `bun add @anthropic-ai/sandbox-runtime`，写一个一次性脚本 `daemon/scratch-srt-spike.ts`：`import { SandboxManager }`，用它跑 `bun -e 'require("fs").writeFileSync("/tmp/should-fail","x")'` 且 settings 只允许写某临时 workspace，断言写 `/tmp` 被拒、写 workspace 成功、`curl example.com` 类出口被断。先直接 `bun run daemon/scratch-srt-spike.ts` 验证库在 bun runtime 下可用。

- [ ] **Step 2: 验证编译后二进制**

`cd daemon && bun run compile`，把 spike 逻辑并进一个临时 CLI 子命令或独立 compile 目标，`rm -f ~/.pie/bin/pie-spike && bun build ... --outfile /tmp/pie-spike && /tmp/pie-spike`，确认 srt 在 `--compile` 产物里仍工作（回答问题 1/2）。记录 ripgrep/代理进程依赖情况。

- [ ] **Step 3: 定后端，写 `skill-sandbox.ts`**

按 Step 1/2 结论实现 `realSkillSandbox`：
- srt 可内嵌 → `run()` 用 `SandboxManager` 起进程、把 `SandboxSettings` 翻译成 srt 的 `~/.srt-settings.json`/`SandboxManager` 配置（`allowWrite`→filesystem write allow-list；`allowedDomains`→network allow-list；`denyRead`→filesystem read deny-list），保留 60s 超时 + 1MB stdout/stderr 双路封顶（照搬 2b `realSkillSpawn` 的并发排空 + 增量封顶逻辑，避免 stderr 管道写满死锁）。
- 回退 → `run()` 用 `sandbox-exec -f <profile>`，profile 由 `SandboxSettings` 生成（`allowWrite`→`(allow file-write* (subpath ...))`、`denyRead`→`(deny file-read* (subpath ...))`、网络 `(deny network*)`）。

`fakeSkillSandbox(impl)` 直接返回 `{ run: impl }`。

- [ ] **Step 4: 测接口契约（非真强制）**

```ts
// daemon/test/skill-sandbox.test.ts
import { test, expect } from "bun:test";
import { fakeSkillSandbox } from "../src/skill-sandbox";

test("fakeSkillSandbox forwards args to impl and returns its result", async () => {
  const seen: unknown[] = [];
  const sb = fakeSkillSandbox(async (argv, cwd, env, settings) => {
    seen.push({ argv, cwd, env, settings });
    return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  const r = await sb.run(["node", "x.js"], "/tmp/skill", { A: "1" }, { allowWrite: ["/tmp/skill/workspace"], allowedDomains: [], denyRead: ["/Users/me/.ssh"] });
  expect(r.stdout).toBe("ok");
  expect(seen).toHaveLength(1);
});
```

Run: `cd daemon && bun test test/skill-sandbox.test.ts` → PASS。

- [ ] **Step 5: 真机验证清单（人工，记进决策记录）**

用 `realSkillSandbox` 跑四个探针脚本，逐条断言：
1. 默认断网：脚本 `fetch("https://example.com")` → 失败/被拒。
2. 写限 workspace：写 `<skillDir>/workspace/x` 成功；写 `<skillDir>/scripts/x`、`/tmp/x`、`~/x` → 被拒。
3. 声明域名放行：settings.allowedDomains=["example.com"] → `fetch("https://example.com")` 成功、`fetch("https://evil.com")` 仍拒。
4. 敏感读拒：读 `~/.ssh/id_rsa`（放个假文件）→ 被拒；读普通文件 → 成功。

- [ ] **Step 6: 写决策记录并提交**

`docs/plans/2026-07-10-skill-daemon-fs-foundation.spike.md` 记录问题 1/2/3 结论、选定后端、srt 锁定版本、真机清单结果。

```bash
git add daemon/src/skill-sandbox.ts daemon/test/skill-sandbox.test.ts daemon/package.json daemon/bun.lock docs/plans/2026-07-10-skill-daemon-fs-foundation.spike.md
git commit -m "spike(daemon): SkillSandbox backend (srt or sandbox-exec fallback) + interface"
```

---

### Task 2: 协议类型 + paths + `skill_fs` capability

**Files:**
- Modify: `src/types/local-bridge.ts`
- Modify: `daemon/src/paths.ts`
- Test: `daemon/test/paths.test.ts`（新建，轻断言）

**Interfaces:**
- Consumes: 无（纯类型 + 常量）。
- Produces: 下列全部类型 + `paths.skillsDir`/`grantsPath`/`auditPath`，Task 3-8 与 Slice 2/3 依赖。

- [ ] **Step 1: 扩 `local-bridge.ts` — capability + 类型**

在 `BRIDGE_CAPABILITIES` 加 `"skill_fs"`：

```ts
export const BRIDGE_CAPABILITIES = [
  "run_local_agent",
  "handoff_to_agent",
  "list_agents",
  "skill_fs",
] as const;
```

文件末尾（`BridgeResponse` 之前）加 skill_fs 段：

```ts
// ── skill_fs ──────────────────────────────────────────────────────────
/** skill 声明的高危能力（来自 SKILL.md metadata.pie）。 */
export interface SkillCaps {
  /** 允许出口的域名 */
  network: string[];
  /** 工作区外额外可写路径（可含 ~） */
  write: string[];
}
/** list_skills 每项：catalog 呈现 + 授权卡渲染所需的结构化摘要。 */
export interface SkillSummary {
  name: string;
  description: string;
  /** scripts/ 下可执行文件的相对名（如 "fetch.ts"）；run_skill_script 的 allowlist */
  runnableScripts: string[];
  declaredCaps: SkillCaps;
}
export interface ListSkillsResult {
  skills: SkillSummary[];
}

export interface ReadSkillFileParams {
  name: string;
  /** skill 目录内相对路径（如 "SKILL.md" / "references/foo.md"） */
  path: string;
}
export interface ReadSkillFileResult {
  content: string;
}

export interface RunSkillScriptParams {
  name: string;
  /** 必须 ∈ 该 skill runnableScripts */
  entry: string;
  /** CLI 风格参数 */
  args?: string[];
  /** 用户在授权卡批准后置 true；缺省首跑 ungranted skill 会回 needs_authorization */
  grantApproved?: boolean;
}
export interface RunSkillScriptResult {
  /** 脚本 stdout，调用方包 <untrusted_skill_content> */
  output: string;
  truncated?: boolean;
}

export interface WriteSkillFile {
  /** skill 目录内相对路径 */
  path: string;
  content: string;
}
export interface WriteSkillParams {
  name: string;
  files: WriteSkillFile[];
}
export interface WriteSkillResult {
  /** 落盘的 skill 目录绝对路径 */
  dir: string;
}

export interface DeleteSkillParams {
  name: string;
}
export interface DeleteSkillResult {
  deleted: boolean;
}

/** grant 信封：三者规范化后哈希即 grant 身份。 */
export interface GrantEnvelope {
  allowedDomains: string[];
  extraWrites: string[];
  runnableScripts: string[];
}
export interface GrantRecord {
  key: string;
  skillName: string;
  envelope: GrantEnvelope;
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

扩 `BridgeRequest["method"]` 联合：

```ts
export interface BridgeRequest {
  id: string;
  method:
    | "hello"
    | "run_local_agent"
    | "handoff_to_agent"
    | "list_agents"
    | "list_skills"
    | "read_skill_file"
    | "run_skill_script"
    | "write_skill"
    | "delete_skill"
    | "list_grants"
    | "revoke_grant";
  params: unknown;
}
```

- [ ] **Step 2: 扩 `paths.ts`**

```ts
import { homedir } from "os";
import { join } from "path";

const pieDir = join(homedir(), ".pie");
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

- [ ] **Step 3: 轻测 paths**

```ts
// daemon/test/paths.test.ts
import { test, expect } from "bun:test";
import { join } from "path";
import { paths } from "../src/paths";

test("skill_fs paths sit under ~/.pie", () => {
  expect(paths.skillsDir).toBe(join(paths.pieDir, "skills"));
  expect(paths.grantsPath).toBe(join(paths.pieDir, "grants.json"));
  expect(paths.auditPath).toBe(join(paths.pieDir, "logs", "audit.jsonl"));
});
```

Run: `cd daemon && bun test test/paths.test.ts` → PASS。

- [ ] **Step 4: 扩展侧 typecheck 不回归**

Run: `pnpm typecheck` → 0 错（`local-bridge.ts` 是共享源，纯加法不该破坏现有引用）。

- [ ] **Step 5: Commit**

```bash
git add src/types/local-bridge.ts daemon/src/paths.ts daemon/test/paths.test.ts
git commit -m "feat(bridge): skill_fs capability + protocol types + daemon skill paths"
```

---

### Task 3: SKILL.md frontmatter 读取（`skill-md.ts`）

> 扩展的 `parseSkillMarkdown` 解不了标准 frontmatter（不认连字符 key、不认两层嵌套），故 daemon 自带一份用 `yaml` 库的读取器，只取我们消费的字段。

**Files:**
- Create: `daemon/src/skill-md.ts`
- Test: `daemon/test/skill-md.test.ts`
- Modify: `daemon/package.json`（`bun add yaml`）

**Interfaces:**
- Consumes: `SkillCaps`（`local-bridge.ts`，Task 2）。
- Produces:
  ```ts
  export interface ParsedSkillMd { name: string; description: string; declaredCaps: SkillCaps; body: string; }
  export function parseSkillMd(md: string): ParsedSkillMd;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// daemon/test/skill-md.test.ts
import { test, expect } from "bun:test";
import { parseSkillMd } from "../src/skill-md";

const SKILL = `---
name: web-fetch
description: Fetch a URL and summarize.
license: MIT
allowed-tools: [read_page]
metadata:
  pie:
    network: [api.example.com, example.com]
    write: [~/Documents/pie-out]
---
# Web Fetch

Body instructions here.
`;

test("parses standard frontmatter incl. metadata.pie caps and body", () => {
  const p = parseSkillMd(SKILL);
  expect(p.name).toBe("web-fetch");
  expect(p.description).toBe("Fetch a URL and summarize.");
  expect(p.declaredCaps.network).toEqual(["api.example.com", "example.com"]);
  expect(p.declaredCaps.write).toEqual(["~/Documents/pie-out"]);
  expect(p.body.trim().startsWith("# Web Fetch")).toBe(true);
});

test("no metadata.pie → empty caps", () => {
  const p = parseSkillMd(`---\nname: x\ndescription: y\n---\nbody\n`);
  expect(p.declaredCaps).toEqual({ network: [], write: [] });
});

test("throws on missing required fields", () => {
  expect(() => parseSkillMd(`---\ndescription: y\n---\nb\n`)).toThrow(/name/);
  expect(() => parseSkillMd(`no fence`)).toThrow(/frontmatter/);
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd daemon && bun test test/skill-md.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: `bun add yaml` 并实现**

```bash
cd daemon && bun add yaml
```

```ts
// daemon/src/skill-md.ts
import { parse as parseYaml } from "yaml";
import type { SkillCaps } from "../../src/types/local-bridge";

export interface ParsedSkillMd {
  name: string;
  description: string;
  declaredCaps: SkillCaps;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export function parseSkillMd(md: string): ParsedSkillMd {
  const m = md.match(FENCE);
  if (!m) throw new Error("SKILL.md missing --- frontmatter --- fence");
  const [, yaml, body] = m;
  const fm = (parseYaml(yaml) ?? {}) as Record<string, unknown>;

  const name = fm.name;
  const description = fm.description;
  if (typeof name !== "string" || !name) throw new Error("SKILL.md frontmatter missing required `name`");
  if (typeof description !== "string" || !description)
    throw new Error("SKILL.md frontmatter missing required `description`");

  const pie = ((fm.metadata as Record<string, unknown> | undefined)?.pie ?? {}) as Record<string, unknown>;
  return {
    name,
    description,
    declaredCaps: { network: strArray(pie.network), write: strArray(pie.write) },
    body,
  };
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd daemon && bun test test/skill-md.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add daemon/src/skill-md.ts daemon/test/skill-md.test.ts daemon/package.json daemon/bun.lock
git commit -m "feat(daemon): SKILL.md standard-frontmatter reader (name/description/metadata.pie caps)"
```

---

### Task 4: skill 存储读取（`skill-store.ts` — list/read + 名校验）

**Files:**
- Create: `daemon/src/skill-store.ts`
- Test: `daemon/test/skill-store-read.test.ts`

**Interfaces:**
- Consumes: `parseSkillMd`（Task 3）；`SkillSummary`/`ReadSkillFileResult`（Task 2）；`paths.skillsDir`（Task 2）。
- Produces:
  ```ts
  export function assertSkillName(name: string): string;         // 校验+原样返回，非法即 throw
  export function safeRelPath(skillDir: string, rel: string): string;  // 遍历安全的绝对路径
  export function listSkills(root?: string): SkillSummary[];
  export function readSkillFile(name: string, rel: string, root?: string): string;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// daemon/test/skill-store-read.test.ts
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { assertSkillName, listSkills, readSkillFile } from "../src/skill-store";

function tmpRoot(): string {
  const root = join(import.meta.dir, ".tmp-skills-" + Math.random().toString(36).slice(2));
  mkdirSync(root, { recursive: true });
  return root;
}
function makeSkill(root: string, name: string, md: string, scripts: string[] = []) {
  const dir = join(root, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md);
  for (const s of scripts) writeFileSync(join(dir, "scripts", s), "// " + s);
}

test("listSkills returns summary with runnableScripts and declaredCaps", () => {
  const root = tmpRoot();
  makeSkill(
    root,
    "web-fetch",
    `---\nname: web-fetch\ndescription: d\nmetadata:\n  pie:\n    network: [example.com]\n---\nbody\n`,
    ["fetch.ts", "helper.ts"],
  );
  const skills = listSkills(root);
  expect(skills).toHaveLength(1);
  expect(skills[0].name).toBe("web-fetch");
  expect(skills[0].runnableScripts.sort()).toEqual(["fetch.ts", "helper.ts"]);
  expect(skills[0].declaredCaps.network).toEqual(["example.com"]);
  rmSync(root, { recursive: true, force: true });
});

test("listSkills skips dirs without SKILL.md and tolerates a bad skill", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "no-md"), { recursive: true });
  makeSkill(root, "bad", `no fence`, []);
  makeSkill(root, "good", `---\nname: good\ndescription: d\n---\nb\n`, []);
  const names = listSkills(root).map((s) => s.name);
  expect(names).toContain("good");
  expect(names).not.toContain("no-md");
  expect(names).not.toContain("bad");
  rmSync(root, { recursive: true, force: true });
});

test("readSkillFile returns file content; rejects traversal", () => {
  const root = tmpRoot();
  makeSkill(root, "s", `---\nname: s\ndescription: d\n---\nBODY\n`, []);
  expect(readSkillFile("s", "SKILL.md", root)).toContain("BODY");
  expect(() => readSkillFile("s", "../../etc/passwd", root)).toThrow();
  rmSync(root, { recursive: true, force: true });
});

test("assertSkillName rejects traversal / bad chars", () => {
  expect(assertSkillName("web-fetch")).toBe("web-fetch");
  expect(() => assertSkillName("..")).toThrow();
  expect(() => assertSkillName("a/b")).toThrow();
  expect(() => assertSkillName("Web_Fetch")).toThrow();
  expect(() => assertSkillName("")).toThrow();
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd daemon && bun test test/skill-store-read.test.ts` → FAIL。

- [ ] **Step 3: 实现 read 部分**

```ts
// daemon/src/skill-store.ts
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import { paths } from "./paths";
import { parseSkillMd } from "./skill-md";
import type { SkillSummary } from "../../src/types/local-bridge";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** skill 名 = 目录名 = id：kebab-case，无路径分隔符/遍历。非法即 throw。 */
export function assertSkillName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** 把 skill 目录内相对路径解析成绝对路径，越出目录即 throw。 */
export function safeRelPath(skillDir: string, rel: string): string {
  const abs = resolve(skillDir, rel);
  const r = relative(skillDir, abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) {
    throw new Error(`unsafe path: ${JSON.stringify(rel)}`);
  }
  return abs;
}

/** scripts/ 下的文件名（一层，非递归）= 可执行集。目录不存在 → 空。 */
function runnableScripts(skillDir: string): string[] {
  const dir = join(skillDir, "scripts");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function listSkills(root: string = paths.skillsDir): SkillSummary[] {
  if (!existsSync(root)) return [];
  const out: SkillSummary[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
    const dir = join(root, e.name);
    const mdPath = join(dir, "SKILL.md");
    if (!existsSync(mdPath)) continue;
    try {
      const parsed = parseSkillMd(readFileSync(mdPath, "utf8"));
      out.push({
        name: e.name, // 目录名即身份（与 frontmatter.name 应一致，以目录为准）
        description: parsed.description,
        runnableScripts: runnableScripts(dir),
        declaredCaps: parsed.declaredCaps,
      });
    } catch {
      // 坏 skill 跳过、不让整个 list 挂（韧性；坏 skill 在 authoring 期暴露）
    }
  }
  return out;
}

export function readSkillFile(name: string, rel: string, root: string = paths.skillsDir): string {
  const dir = join(root, assertSkillName(name));
  return readFileSync(safeRelPath(dir, rel), "utf8");
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd daemon && bun test test/skill-store-read.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add daemon/src/skill-store.ts daemon/test/skill-store-read.test.ts
git commit -m "feat(daemon): skill-store read layer (listSkills/readSkillFile) + name/path guards"
```

---

### Task 5: skill 落盘/删除（`skill-store.ts` — write/delete）

**Files:**
- Modify: `daemon/src/skill-store.ts`
- Test: `daemon/test/skill-store-write.test.ts`

**Interfaces:**
- Consumes: `assertSkillName`/`safeRelPath`（Task 4）；`WriteSkillFile`（Task 2）；`paths.skillsDir`。
- Produces:
  ```ts
  export function writeSkill(name: string, files: WriteSkillFile[], root?: string): { dir: string };
  export function deleteSkill(name: string, root?: string): boolean;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// daemon/test/skill-store-write.test.ts
import { test, expect } from "bun:test";
import { mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { writeSkill, deleteSkill } from "../src/skill-store";

function tmpRoot(): string {
  const root = join(import.meta.dir, ".tmp-skw-" + Math.random().toString(36).slice(2));
  mkdirSync(root, { recursive: true });
  return root;
}

test("writeSkill lays out SKILL.md + nested files, returns dir", () => {
  const root = tmpRoot();
  const { dir } = writeSkill(
    "my-skill",
    [
      { path: "SKILL.md", content: "---\nname: my-skill\ndescription: d\n---\nb\n" },
      { path: "scripts/run.ts", content: "export default () => 1;" },
    ],
    root,
  );
  expect(dir).toBe(join(root, "my-skill"));
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("my-skill");
  expect(readFileSync(join(dir, "scripts", "run.ts"), "utf8")).toContain("export default");
  rmSync(root, { recursive: true, force: true });
});

test("writeSkill rejects bad name and path traversal in files", () => {
  const root = tmpRoot();
  expect(() => writeSkill("..", [{ path: "SKILL.md", content: "x" }], root)).toThrow();
  expect(() => writeSkill("ok", [{ path: "../escape", content: "x" }], root)).toThrow();
  rmSync(root, { recursive: true, force: true });
});

test("deleteSkill removes the dir; returns false if absent", () => {
  const root = tmpRoot();
  writeSkill("gone", [{ path: "SKILL.md", content: "---\nname: gone\ndescription: d\n---\nb\n" }], root);
  expect(deleteSkill("gone", root)).toBe(true);
  expect(existsSync(join(root, "gone"))).toBe(false);
  expect(deleteSkill("gone", root)).toBe(false);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd daemon && bun test test/skill-store-write.test.ts` → FAIL。

- [ ] **Step 3: 实现 write/delete（追加进 `skill-store.ts`）**

顶部 import 补 `mkdirSync, writeFileSync, rmSync` 与 `dirname`、`WriteSkillFile` 类型：

```ts
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve, relative, isAbsolute, dirname } from "path";
import type { SkillSummary, WriteSkillFile } from "../../src/types/local-bridge";
```

追加：

```ts
export function writeSkill(
  name: string,
  files: WriteSkillFile[],
  root: string = paths.skillsDir,
): { dir: string } {
  const dir = join(root, assertSkillName(name));
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const abs = safeRelPath(dir, f.path); // 遍历/越界即 throw
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return { dir };
}

export function deleteSkill(name: string, root: string = paths.skillsDir): boolean {
  const dir = join(root, assertSkillName(name));
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd daemon && bun test test/skill-store-write.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add daemon/src/skill-store.ts daemon/test/skill-store-write.test.ts
git commit -m "feat(daemon): skill-store write/delete (authoring + migration landing)"
```

---

### Task 6: grant 模型（per-skill 信封）+ audit

> 重写 2b 的 `grants.ts`：从「code-hash」翻成「能力信封」；平移 2b 的 `audit.ts`。

**Files:**
- Create: `daemon/src/grants.ts`
- Create: `daemon/src/audit.ts`
- Test: `daemon/test/grants.test.ts`

**Interfaces:**
- Consumes: `GrantEnvelope`/`GrantRecord`（Task 2）；`paths.grantsPath`/`auditPath`。
- Produces:
  ```ts
  export function canonicalEnvelope(e: GrantEnvelope): GrantEnvelope;   // 排序去重规范化
  export function envelopeHash(e: GrantEnvelope): string;
  export function grantKey(skillName: string, e: GrantEnvelope): string;
  export function hasGrant(skillName: string, e: GrantEnvelope, path?: string): boolean;
  export function putGrant(rec: GrantRecord, path?: string): void;
  export function listGrants(path?: string): GrantRecord[];
  export function revokeGrant(key: string, path?: string): boolean;
  // audit.ts
  export interface AuditEntry { ts: number; skillName: string; entry: string; envelope: GrantEnvelope; exitCode: number; timedOut: boolean; truncated: boolean; ms: number; }
  export function appendAudit(entry: AuditEntry, path?: string): void;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// daemon/test/grants.test.ts
import { test, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  canonicalEnvelope, grantKey, hasGrant, putGrant, listGrants, revokeGrant,
} from "../src/grants";
import type { GrantEnvelope } from "../../src/types/local-bridge";

function tmpPath(): string {
  const dir = join(import.meta.dir, ".tmp-grants-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return join(dir, "grants.json");
}
const ENV: GrantEnvelope = { allowedDomains: ["b.com", "a.com"], extraWrites: ["~/out"], runnableScripts: ["y.ts", "x.ts"] };

test("canonicalEnvelope sorts+dedups so key is order-insensitive", () => {
  const k1 = grantKey("s", { allowedDomains: ["a.com", "b.com"], extraWrites: ["~/out"], runnableScripts: ["x.ts", "y.ts"] });
  const k2 = grantKey("s", ENV);
  expect(k1).toBe(k2);
});

test("put/has/list/revoke round-trip", () => {
  const p = tmpPath();
  expect(hasGrant("s", ENV, p)).toBe(false);
  const key = grantKey("s", ENV);
  putGrant({ key, skillName: "s", envelope: canonicalEnvelope(ENV), grantedAt: 1 }, p);
  expect(hasGrant("s", ENV, p)).toBe(true);
  expect(listGrants(p).map((g) => g.skillName)).toEqual(["s"]);
  expect(revokeGrant(key, p)).toBe(true);
  expect(hasGrant("s", ENV, p)).toBe(false);
  expect(revokeGrant(key, p)).toBe(false);
  rmSync(p, { force: true });
});

test("envelope change (added domain) → different key → re-prompt", () => {
  const wider: GrantEnvelope = { ...ENV, allowedDomains: [...ENV.allowedDomains, "c.com"] };
  expect(grantKey("s", wider)).not.toBe(grantKey("s", ENV));
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd daemon && bun test test/grants.test.ts` → FAIL。

- [ ] **Step 3: 实现 `grants.ts`**

```ts
// daemon/src/grants.ts
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";
import type { GrantEnvelope, GrantRecord } from "../../src/types/local-bridge";

interface GrantsFile {
  version: number;
  grants: Record<string, GrantRecord>;
}

function uniqSort(a: string[]): string[] {
  return [...new Set(a)].sort();
}

/** 排序去重三字段——信封身份与声明顺序无关。 */
export function canonicalEnvelope(e: GrantEnvelope): GrantEnvelope {
  return {
    allowedDomains: uniqSort(e.allowedDomains),
    extraWrites: uniqSort(e.extraWrites),
    runnableScripts: uniqSort(e.runnableScripts),
  };
}

export function envelopeHash(e: GrantEnvelope): string {
  return createHash("sha256").update(JSON.stringify(canonicalEnvelope(e))).digest("hex").slice(0, 32);
}

export function grantKey(skillName: string, e: GrantEnvelope): string {
  return `skill:${skillName}:${envelopeHash(e)}`;
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

export function hasGrant(skillName: string, e: GrantEnvelope, path = paths.grantsPath): boolean {
  return grantKey(skillName, e) in read(path).grants;
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

- [ ] **Step 4: 实现 `audit.ts`（平移 2b + 换 envelope 字段）**

```ts
// daemon/src/audit.ts
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";
import type { GrantEnvelope } from "../../src/types/local-bridge";

export interface AuditEntry {
  ts: number;
  skillName: string;
  entry: string;
  envelope: GrantEnvelope;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

// best-effort：审计失败绝不阻断执行（spec §安全模型 audit = 知情权，非闸）。
export function appendAudit(entry: AuditEntry, path = paths.auditPath): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    /* swallow */
  }
}
```

- [ ] **Step 5: 跑测确认通过**

Run: `cd daemon && bun test test/grants.test.ts` → PASS。

- [ ] **Step 6: Commit**

```bash
git add daemon/src/grants.ts daemon/src/audit.ts daemon/test/grants.test.ts
git commit -m "feat(daemon): per-skill envelope grant ledger + audit (reworked 2b spine)"
```

---

### Task 7: `run_skill_script` 编排（`skill-exec.ts`）

**Files:**
- Create: `daemon/src/skill-exec.ts`
- Test: `daemon/test/skill-exec.test.ts`

**Interfaces:**
- Consumes: `SkillSandbox`/`SandboxSettings`（Task 1）；`listSkills`/`readSkillFile`/`assertSkillName`（Task 4）；grant fns（Task 6）；`appendAudit`（Task 6）；`RunSkillScriptParams`/`RunSkillScriptResult`（Task 2）；`paths`。
- Produces:
  ```ts
  export function expandTilde(p: string): string;
  export function baselineDenyRead(): string[];
  export function interpreterFor(entry: string): string[];   // argv 前缀
  export function runSkillScript(params: RunSkillScriptParams, deps?: SkillExecDeps): Promise<RunSkillScriptResult>;
  export interface SkillExecDeps { sandbox?: SkillSandbox; now?: () => number; skillsRoot?: string; grantsPath?: string; auditPath?: string; }
  ```

**编排流程（错误码固定，Slice 2 客户端据此分支）：**
1. `assertSkillName` → 找 skill summary（`listSkills` 里按名取；缺 → `unknown_skill`）。
2. `entry ∈ summary.runnableScripts`？否 → `unknown_entry`。
3. 信封 = `{allowedDomains: declaredCaps.network, extraWrites: declaredCaps.write, runnableScripts}`。
4. `hasGrant`？否 且 `!grantApproved` → 抛 `needs_authorization`（零副作用）。否 且 `grantApproved` → `putGrant`。
5. 组装 `SandboxSettings`：`allowWrite = [<skillDir>/workspace, ...extraWrites.map(expandTilde)]`；`allowedDomains = declaredCaps.network`；`denyRead = baselineDenyRead()`。
6. `mkdirSync(<skillDir>/workspace)`；`argv = [...interpreterFor(entry), <skillDir>/scripts/<entry>, ...args]`；`sandbox.run(argv, cwd=<skillDir>, env, settings)`。
7. `appendAudit`。
8. `timedOut`→`timeout`；`exitCode!==0`→`script_error`（带 stderr 尾 2000）；否则回 `{output: stdout, truncated}`。

- [ ] **Step 1: 写失败测试（注入 fakeSkillSandbox + 临时 skill 目录）**

```ts
// daemon/test/skill-exec.test.ts
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { runSkillScript, expandTilde } from "../src/skill-exec";
import { fakeSkillSandbox } from "../src/skill-sandbox";
import { hasGrant } from "../src/grants";
import type { SandboxSettings } from "../src/skill-sandbox";
import { setLogEnabled } from "../src/log";

setLogEnabled(false);

function fixture() {
  const base = join(import.meta.dir, ".tmp-exec-" + Math.random().toString(36).slice(2));
  const skillsRoot = join(base, "skills");
  const dir = join(skillsRoot, "web-fetch");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: web-fetch\ndescription: d\nmetadata:\n  pie:\n    network: [example.com]\n    write: [~/out]\n---\nb\n`,
  );
  writeFileSync(join(dir, "scripts", "fetch.ts"), "export default () => 1;");
  return { base, skillsRoot, grantsPath: join(base, "grants.json"), auditPath: join(base, "audit.jsonl") };
}

test("ungranted + no approval → needs_authorization, no grant written, no run", async () => {
  const f = fixture();
  let ran = false;
  const sandbox = fakeSkillSandbox(async () => { ran = true; return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }; });
  await expect(
    runSkillScript({ name: "web-fetch", entry: "fetch.ts" }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  expect(ran).toBe(false);
  expect(hasGrant("web-fetch", { allowedDomains: ["example.com"], extraWrites: ["~/out"], runnableScripts: ["fetch.ts"] }, f.grantsPath)).toBe(false);
  rmSync(f.base, { recursive: true, force: true });
});

test("approved → writes grant, runs with baseline+declared settings, returns stdout", async () => {
  const f = fixture();
  let seen: SandboxSettings | undefined;
  const sandbox = fakeSkillSandbox(async (_argv, _cwd, _env, settings) => { seen = settings; return { stdout: "RESULT", stderr: "", exitCode: 0, timedOut: false, truncated: false }; });
  const r = await runSkillScript({ name: "web-fetch", entry: "fetch.ts", grantApproved: true }, { sandbox, now: () => 1, ...f });
  expect(r.output).toBe("RESULT");
  expect(seen!.allowedDomains).toEqual(["example.com"]);
  expect(seen!.allowWrite.some((w) => w.endsWith("/web-fetch/workspace"))).toBe(true);
  expect(seen!.allowWrite).toContain(expandTilde("~/out"));
  expect(seen!.denyRead.some((d) => d.endsWith("/.ssh"))).toBe(true);
  rmSync(f.base, { recursive: true, force: true });
});

test("second run after grant → no re-prompt", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "x", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await runSkillScript({ name: "web-fetch", entry: "fetch.ts", grantApproved: true }, { sandbox, now: () => 1, ...f });
  const r = await runSkillScript({ name: "web-fetch", entry: "fetch.ts" }, { sandbox, now: () => 2, ...f }); // 无 grantApproved 也不弹
  expect(r.output).toBe("x");
  rmSync(f.base, { recursive: true, force: true });
});

test("entry not in scripts/ → unknown_entry (before any grant/run)", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await expect(
    runSkillScript({ name: "web-fetch", entry: "../../etc/passwd", grantApproved: true }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "unknown_entry" });
  rmSync(f.base, { recursive: true, force: true });
});

test("script non-zero exit → script_error with stderr tail", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false, truncated: false }));
  await expect(
    runSkillScript({ name: "web-fetch", entry: "fetch.ts", grantApproved: true }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "script_error" });
  rmSync(f.base, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd daemon && bun test test/skill-exec.test.ts` → FAIL。

- [ ] **Step 3: 实现 `skill-exec.ts`**

```ts
// daemon/src/skill-exec.ts
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { paths } from "./paths";
import { log } from "./log";
import { assertSkillName, listSkills } from "./skill-store";
import { hasGrant, putGrant, grantKey, canonicalEnvelope } from "./grants";
import { appendAudit } from "./audit";
import { realSkillSandbox } from "./skill-sandbox";
import type { SkillSandbox } from "./skill-sandbox";
import type { GrantEnvelope, RunSkillScriptParams, RunSkillScriptResult } from "../../src/types/local-bridge";

export interface SkillExecDeps {
  sandbox?: SkillSandbox;
  now?: () => number;
  skillsRoot?: string;
  grantsPath?: string;
  auditPath?: string;
}

export function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** 敏感目录默认拒读（write 类外泄面靠默认断网压制，这里挡直接读密钥）。 */
export function baselineDenyRead(): string[] {
  const h = homedir();
  return [
    join(h, ".ssh"),
    join(h, ".aws"),
    join(h, ".gnupg"),
    paths.grantsPath,
    paths.logsDir,
  ];
}

/** 解释器 argv 前缀：.ts/.js/.mjs → pie-as-bun；.py → python3；.sh → bash。 */
export function interpreterFor(entry: string): string[] {
  if (/\.(ts|js|mjs|cjs)$/.test(entry)) return [process.execPath, "run"]; // 需 BUN_BE_BUN=1
  if (/\.py$/.test(entry)) return ["python3"];
  if (/\.sh$/.test(entry)) return ["bash"];
  return [process.execPath, "run"]; // 默认按 JS 跑
}

export async function runSkillScript(
  params: RunSkillScriptParams,
  deps: SkillExecDeps = {},
): Promise<RunSkillScriptResult> {
  const now = deps.now ?? Date.now;
  const skillsRoot = deps.skillsRoot ?? paths.skillsDir;
  const grantsPath = deps.grantsPath ?? paths.grantsPath;
  const auditPath = deps.auditPath ?? paths.auditPath;
  const sandbox = deps.sandbox ?? realSkillSandbox;

  const name = assertSkillName(params.name);
  const summary = listSkills(skillsRoot).find((s) => s.name === name);
  if (!summary) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
  if (!summary.runnableScripts.includes(params.entry)) {
    throw Object.assign(new Error(`entry not in scripts/: ${JSON.stringify(params.entry)}`), { code: "unknown_entry" });
  }

  const envelope: GrantEnvelope = canonicalEnvelope({
    allowedDomains: summary.declaredCaps.network,
    extraWrites: summary.declaredCaps.write,
    runnableScripts: summary.runnableScripts,
  });

  if (!hasGrant(name, envelope, grantsPath)) {
    if (!params.grantApproved) {
      throw Object.assign(new Error("authorization required"), { code: "needs_authorization" });
    }
    putGrant({ key: grantKey(name, envelope), skillName: name, envelope, grantedAt: now() }, grantsPath);
  }

  const skillDir = join(skillsRoot, name);
  const workspace = join(skillDir, "workspace");
  mkdirSync(workspace, { recursive: true });

  const settings = {
    allowWrite: [workspace, ...summary.declaredCaps.write.map(expandTilde)],
    allowedDomains: summary.declaredCaps.network,
    denyRead: baselineDenyRead(),
  };
  const argv = [...interpreterFor(params.entry), join(skillDir, "scripts", params.entry), ...(params.args ?? [])];
  const env = { BUN_BE_BUN: "1" };

  const startedAt = now();
  log("info", "skill.run", { name, entry: params.entry });
  const res = await sandbox.run(argv, skillDir, env, settings);

  appendAudit(
    { ts: now(), skillName: name, entry: params.entry, envelope, exitCode: res.exitCode, timedOut: res.timedOut, truncated: res.truncated, ms: now() - startedAt },
    auditPath,
  );

  if (res.timedOut) throw Object.assign(new Error("skill script timed out"), { code: "timeout" });
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(`skill script exited ${res.exitCode}: ${res.stderr.trim().slice(-2000)}`), { code: "script_error" });
  }
  return { output: res.stdout, truncated: res.truncated || undefined };
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd daemon && bun test test/skill-exec.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add daemon/src/skill-exec.ts daemon/test/skill-exec.test.ts
git commit -m "feat(daemon): run_skill_script orchestration (grant gate + entry guard + settings assembly + audit)"
```

---

### Task 8: daemon dispatch 接线 + `skill_fs` 广播 + 集成测试

**Files:**
- Modify: `daemon/src/daemon.ts`
- Test: `daemon/test/daemon-skill-fs.test.ts`

**Interfaces:**
- Consumes: `listSkills`/`readSkillFile`/`writeSkill`/`deleteSkill`（Task 4/5）；`runSkillScript`（Task 7）；`listGrants`/`revokeGrant`（Task 6）；类型（Task 2）。
- Produces: 桥上 7 个可调方法 + `hello` capabilities 含 `skill_fs`。

- [ ] **Step 1: 写失败测试（走 `handleMessage`，端到端 JSON）**

```ts
// daemon/test/daemon-skill-fs.test.ts
import { test, expect } from "bun:test";
import { handleMessage } from "../src/daemon";
import { setLogEnabled } from "../src/log";

setLogEnabled(false);

test("hello advertises skill_fs", async () => {
  const out = JSON.parse(await handleMessage(JSON.stringify({ id: "1", method: "hello", params: { protocolVersion: 1 } })));
  expect(out.ok).toBe(true);
  expect(out.result.capabilities).toContain("skill_fs");
});

test("list_skills returns ok envelope (empty when no skills dir)", async () => {
  const out = JSON.parse(await handleMessage(JSON.stringify({ id: "2", method: "list_skills", params: {} })));
  expect(out.ok).toBe(true);
  expect(Array.isArray(out.result.skills)).toBe(true);
});

test("unknown_method still handled", async () => {
  const out = JSON.parse(await handleMessage(JSON.stringify({ id: "3", method: "nope", params: {} })));
  expect(out.ok).toBe(false);
  expect(out.error.code).toBe("unknown_method");
});

test("run_skill_script on missing skill → ok:false with unknown_skill code (not a hang)", async () => {
  const out = JSON.parse(await handleMessage(JSON.stringify({ id: "4", method: "run_skill_script", params: { name: "nope-skill", entry: "x.ts" } })));
  expect(out.ok).toBe(false);
  expect(out.error.code).toBe("unknown_skill");
});
```

> 注：`list_skills`/`run_skill_script` 读真实 `paths.skillsDir`（`~/.pie/skills`）。测试只断言「信封形状 + 错误码正确、不挂起」，不依赖具体 skill 内容——空目录返回空数组、缺 skill 返回 `unknown_skill`，两者都 hermetic。

- [ ] **Step 2: 跑测确认失败**

Run: `cd daemon && bun test test/daemon-skill-fs.test.ts` → FAIL（方法未接线）。

- [ ] **Step 3: 接线 `daemon.ts`**

顶部补 import：

```ts
import { listSkills, readSkillFile, writeSkill, deleteSkill } from "./skill-store";
import { runSkillScript } from "./skill-exec";
import { listGrants, revokeGrant } from "./grants";
import type {
  ReadSkillFileParams, RunSkillScriptParams, WriteSkillParams, DeleteSkillParams, RevokeGrantParams,
} from "../../src/types/local-bridge";
```

在 `switch` 里 `list_agents` case 之后、`default` 之前插入 7 个 case（全部 try/catch 对称——见文件顶部对 `list_agents` 的注释：抛异常会让 SW 的无超时 `send()` 永久挂起）：

```ts
    case "list_skills": {
      try {
        return respond({ ok: true, result: { skills: listSkills() } });
      } catch (e) {
        log("error", "list_skills.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "list_skills_failed", message: String(e) } });
      }
    }
    case "read_skill_file": {
      try {
        const p = msg.params as ReadSkillFileParams;
        return respond({ ok: true, result: { content: readSkillFile(p.name, p.path) } });
      } catch (e) {
        log("error", "read_skill_file.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "read_skill_file_failed", message: String(e) } });
      }
    }
    case "run_skill_script": {
      try {
        const result = await runSkillScript(msg.params as RunSkillScriptParams);
        return respond({ ok: true, result });
      } catch (e) {
        // 保留业务错误码（needs_authorization / unknown_skill / unknown_entry / timeout / script_error）
        const code = (e as { code?: string }).code ?? "run_skill_script_failed";
        log("error", "run_skill_script.failed", { id, code, error: String(e) });
        return respond({ ok: false, error: { code, message: String(e) } });
      }
    }
    case "write_skill": {
      try {
        const p = msg.params as WriteSkillParams;
        return respond({ ok: true, result: writeSkill(p.name, p.files) });
      } catch (e) {
        log("error", "write_skill.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "write_skill_failed", message: String(e) } });
      }
    }
    case "delete_skill": {
      try {
        const p = msg.params as DeleteSkillParams;
        return respond({ ok: true, result: { deleted: deleteSkill(p.name) } });
      } catch (e) {
        log("error", "delete_skill.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "delete_skill_failed", message: String(e) } });
      }
    }
    case "list_grants": {
      try {
        return respond({ ok: true, result: { grants: listGrants() } });
      } catch (e) {
        log("error", "list_grants.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "list_grants_failed", message: String(e) } });
      }
    }
    case "revoke_grant": {
      try {
        const p = msg.params as RevokeGrantParams;
        return respond({ ok: true, result: { revoked: revokeGrant(p.key) } });
      } catch (e) {
        log("error", "revoke_grant.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "revoke_grant_failed", message: String(e) } });
      }
    }
```

`skill_fs` 已在 `BRIDGE_CAPABILITIES`（Task 2）→ `hello` 自动广播，无需改 `hello` case。

- [ ] **Step 4: 跑测确认通过 + 全量 daemon 测试**

Run: `cd daemon && bun test test/daemon-skill-fs.test.ts` → PASS。
Run: `cd daemon && bun test` → 全绿。

- [ ] **Step 5: 编译验证（invariant：二进制能 build）**

Run: `cd daemon && bun run compile` → 生成 `dist/pie` 无错。

- [ ] **Step 6: Commit**

```bash
git add daemon/src/daemon.ts daemon/test/daemon-skill-fs.test.ts
git commit -m "feat(daemon): wire skill_fs dispatch (list/read/run/write/delete/grants) with try-catch symmetry"
```

---

## 真机验证清单（Slice 1 完成后，人工）

CI 的 `bun test` 碰不到 OS 沙箱强制，以下必真机（`realSkillSandbox`）：

1. 手放一个 skill 到 `~/.pie/skills/hello/`（`SKILL.md` + `scripts/run.ts`），`list_skills` 经桥回该 skill、`runnableScripts=["run.ts"]`。
2. 首跑 `run_skill_script(hello, run.ts)` → `needs_authorization`；带 `grantApproved:true` 重跑 → 出 stdout；`~/.pie/grants.json` 出现该 grant；二跑不再要授权。
3. Task 1 的四条 srt 强制探针（断网 / 写限 workspace / 声明域名放行 / 敏感读拒）在真 daemon 里复验。
4. `~/.pie/logs/audit.jsonl` 每次执行追加一行（skill/entry/exit/ms）。
5. `list_grants` 列出、`revoke_grant` 撤销后该 skill 再跑重新要授权。
6. 改 skill 脚本代码（信封不变）→ 不重弹；给 `metadata.pie.network` 加一个域名（信封变）→ 重弹。

## Slice 1 完成判据

- `cd daemon && bun test` 全绿；`bun run compile` 出二进制。
- 扩展侧 `pnpm typecheck` 0 错（只动了共享 `local-bridge.ts`，纯加法）。
- 真机清单 1-6 过。
- 桥上 `skill_fs` capability + 7 方法可用，为 Slice 2（扩展 `SkillSource`）就绪。
