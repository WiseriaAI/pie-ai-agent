# Local Daemon Bridge — Slice 1（hand-off）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Slice 0 已打通的桥上加第二条能力路径——**hand-off**：LLM 调 `handoff_to_agent(context, files?)` → HITL 授权卡 → daemon 建 `~/pie-handoffs/<date>-<slug>/` 落盘 `context.md` + stage 文件 → `open` 一个 `.command` 脚本唤起**交互式** `claude` 终端会话（预注入「读 context.md 继续」）→ 侧栏拿回目录路径。**fire-and-forget，不回传结果**。

**Architecture:** 复用 Slice 0 全部基建（native host / socket / framing / HITL panel-request 原语 / bridge 连通门禁 / 构建期 tool 不变量）。daemon 新增一条 `handoff_to_agent` 方法 + `runHandoff` 执行器（注入 spawn/ensureDir/writeFile/now 保持 hermetic 测试）。扩展新增 `handoff_to_agent` 工具 + `HandoffCard` 授权卡 + loop 条件装配。hand-off 与 round-trip 的关键区别：**交互式**（终端里真人在场）→ 不带 `--dangerously-skip-permissions`（claude 自身审批闸有人可批）；**不回传**（工具只返回目录路径，无 `<untrusted_*>` 内容进 loop）。

**Tech Stack:** TypeScript；扩展侧 Vite + vitest；daemon 侧 bun（`bun test`）；macOS `open` + `.command` 脚本唤起 Terminal。

## Global Constraints

（逐条抄自 spec `docs/specs/2026-07-05-local-daemon-bridge.md`，每个 task 隐含遵守）

- **v1 只 macOS**：唤起交互式会话用 `open <file>.command`（macOS 专属），不写 Windows/Linux 分支。
- **协议类型权威源** = `src/types/local-bridge.ts`，daemon 相对 import，**不复制**；加字段只增不改语义，不 bump `PROTOCOL_VERSION`（新增 capability 字符串是纯增量）。
- **能力交集降级（spec §7）**：hand-off 工具**必须**门禁在 `bridgeCapabilities().includes("handoff_to_agent")` 上——新扩展对旧 daemon（Slice 0，只报 `run_local_agent`）时工具不装配，静默降级，不硬挂。
- **授权卡展示原文**：`context` + `target` + 文件数一律原文进卡，不经 LLM 转述。hand-off **每次弹卡、不持久**（spec §6.1：交互式风险低但收益小，不做 grant）。
- **trust boundary 输入校验（不可简化）**：`files[].name` 来自被 untrusted 页面驱动的 LLM——一律取 basename 中和 `../` 遍历，并挡空名 / `.` / `..` / 保留名（`context.md` / `start.command`）。
- **fire-and-forget**：`runHandoff` 只 `open` 终端、不 await claude；工具返回目录路径，**无内容回传 agent loop**，故本 slice **不新增** `untrusted_*` wrapper。
- **构建期不变量**：新工具名 `handoff_to_agent` 必须在 `LOCAL_BRIDGE_TOOL_NAMES` + `TOOL_CLASSES` + `TOOL_GROUPS`（`src/lib/agent/tool-names.ts`）三处登记，否则 module load throw。
- **i18n 字典 parity**：新增文案键必须同步进全部 6 份字典（en / zh-CN / zh-TW / es-419 / ja / pt-BR），`dictionary-parity.test.ts` 强制。
- **提交前**：扩展侧改动跑 `pnpm test` + `pnpm typecheck`（+ 收尾 `pnpm build`）；daemon 侧改动跑 `cd daemon && bun test`。

**本 slice 明确不做（defer，后续 slice）**：skill 执行器、MCP 代理、反向 MCP、grant 持久化、daemon 自更新、`codex` target（只做 `claude`）、终端 app 可配置（默认 `.command` → Terminal.app）、独立的「已交棒」完成卡（目录路径走工具 observation，LLM 自然转述给用户）、doctor 扩展。

---

## File Structure

**新建：**
- `daemon/src/handoff.ts` — `runHandoff` 执行器 + `safeFileName` 校验（注入 spawn/ensureDir/writeFile/now）
- `daemon/test/handoff.test.ts` — hermetic bun 测试
- `src/lib/agent/tools/handoff.ts` — `buildHandoffTool(deps)` 工具工厂
- `src/lib/agent/tools/handoff.test.ts` — 工具单测（vitest）
- `src/sidepanel/components/HandoffCard.tsx` — HITL 授权卡
- `src/sidepanel/components/HandoffCard.test.tsx` — 卡片渲染单测

**修改：**
- `src/types/local-bridge.ts` — `BRIDGE_CAPABILITIES` 加 `handoff_to_agent`；加 `HandoffParams` / `HandoffResult`；`BridgeRequest.method` 并入 `handoff_to_agent`
- `daemon/src/daemon.ts` — `handleMessage` switch 加 `handoff_to_agent` case
- `daemon/test/daemon.test.ts` — hello 测试补断言 capabilities 含 `handoff_to_agent`
- `src/background/local-bridge.ts` — 加 `requestHandoff`；`send` 方法 union 自动含新方法
- `src/background/local-bridge.test.ts` — 补 `requestHandoff` resolve 测试
- `src/lib/agent/tool-names.ts` — `LOCAL_BRIDGE_TOOL_NAMES` 加 `handoff_to_agent` + `TOOL_CLASSES` + `TOOL_GROUPS` 两处显式条目
- `src/lib/panel-request.ts` — `PanelRequestMap` 加 `handoff-to-agent` kind
- `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts` — 加 `handoff.*` 文案块
- `src/sidepanel/components/Chat.tsx` — 渲染 `HandoffCard`
- `src/lib/agent/loop.ts` — `localBridgeTools` 装配加 capability-gated `buildHandoffTool`

---

## Task 1: 协议类型 + daemon 能力声明

**Files:**
- Modify: `src/types/local-bridge.ts`
- Test: `daemon/test/daemon.test.ts`（补现有 hello 测试）

**Interfaces:**
- Produces: `HandoffParams { target: "claude"; context: string; files?: { name: string; content: string }[] }`、`HandoffResult { dir: string }`、`BRIDGE_CAPABILITIES` 含 `"handoff_to_agent"`、`BridgeRequest.method` 含 `"handoff_to_agent"`

- [ ] **Step 1: 写失败测试**（在 `daemon/test/daemon.test.ts` 现有 hello 测试末尾补一行断言）

```ts
// 在 "hello returns protocolVersion + capabilities" 测试里，run_local_agent 那行下面加：
  expect(res.result.capabilities).toContain("handoff_to_agent");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/daemon.test.ts`
Expected: FAIL —— capabilities 只有 `run_local_agent`，不含 `handoff_to_agent`

- [ ] **Step 3: 改类型（`src/types/local-bridge.ts`）**

```ts
// BRIDGE_CAPABILITIES 改为：
export const BRIDGE_CAPABILITIES = ["run_local_agent", "handoff_to_agent"] as const;

// 在 RunLocalAgentResult 定义之后、通用信封之前，插入 handoff 类型：
// ── handoff_to_agent ─────────────────────────────────────────────────
export interface HandoffParams {
  target: "claude"; // Slice 1 只 claude；codex 后续 slice
  /** markdown brief，daemon 落盘为 context.md 供交互式 session 读取 */
  context: string;
  /** 可选：随交棒 stage 进 handoff 目录的文件（名字取 basename，防遍历） */
  files?: { name: string; content: string }[];
}
export interface HandoffResult {
  /** daemon 建的 handoff 目录（回填给侧栏卡片/observation） */
  dir: string;
}

// BridgeRequest.method union 加 handoff_to_agent：
export interface BridgeRequest {
  id: string;
  method: "hello" | "run_local_agent" | "handoff_to_agent";
  params: unknown;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test test/daemon.test.ts`
Expected: PASS（hello 现在自动 advertise 新 capability，因为它 spread `[...BRIDGE_CAPABILITIES]`）

- [ ] **Step 5: 扩展侧 typecheck 不回归**

Run: `pnpm typecheck`
Expected: 0 错（新增类型是纯增量，不破坏 Slice 0 的 `RunLocalAgentParams` 等）

- [ ] **Step 6: 提交**

```bash
git add src/types/local-bridge.ts daemon/test/daemon.test.ts
git commit -m "feat(bridge): protocol types + daemon capability for handoff_to_agent"
```

---

## Task 2: daemon `runHandoff` 执行器 + 路由

**Files:**
- Create: `daemon/src/handoff.ts`
- Create: `daemon/test/handoff.test.ts`
- Modify: `daemon/src/daemon.ts`

**Interfaces:**
- Consumes: `HandoffParams` / `HandoffResult`（Task 1）、`SpawnFn`（`daemon/src/run-local-agent.ts` 已 export）、`paths.handoffsDir`、`log`
- Produces: `runHandoff(params: HandoffParams, opts?): Promise<HandoffResult>`、`safeFileName(name: string): string`

- [ ] **Step 1: 写失败测试（`daemon/test/handoff.test.ts`）**

```ts
import { test, expect } from "bun:test";
import { runHandoff, safeFileName } from "../src/handoff";
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
    now: () => "2026-07-06",
  };
  return { writes, dirs, spawns, opts };
}

test("creates dated dir, writes context.md, opens .command via `open`", async () => {
  const h = harness();
  const r = await runHandoff({ target: "claude", context: "Refactor the auth module" }, h.opts);
  // 目录含日期前缀 + slug
  expect(r.dir).toContain("pie-handoffs");
  expect(r.dir).toContain("2026-07-06-refactor-the-auth-module");
  expect(h.dirs).toContain(r.dir);
  // context.md 原文落盘
  const ctx = h.writes.find((w) => w.path.endsWith("context.md"));
  expect(ctx?.content).toBe("Refactor the auth module");
  // start.command 可执行、内容 cd 进目录并拉起交互式 claude（不带 skip-permissions）
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.mode).toBe(0o755);
  expect(cmd?.content).toContain("exec claude");
  expect(cmd?.content).not.toContain("--dangerously-skip-permissions");
  // 用 `open` 唤起 .command
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].cmd).toBe("open");
  expect(h.spawns[0].args[0]).toContain("start.command");
});

test("stages files with basename, neutralizing path traversal", async () => {
  const h = harness();
  await runHandoff(
    { target: "claude", context: "x", files: [{ name: "../../etc/evil.txt", content: "DATA" }] },
    h.opts,
  );
  // 遍历被中和：写在 handoff 目录内的裸名 evil.txt，不逃逸
  const staged = h.writes.find((w) => w.content === "DATA");
  expect(staged?.path.endsWith("/evil.txt")).toBe(true);
  expect(staged?.path).not.toContain("etc/evil");
});

test("safeFileName rejects reserved / empty / dot names", () => {
  expect(() => safeFileName("context.md")).toThrow();
  expect(() => safeFileName("start.command")).toThrow();
  expect(() => safeFileName("")).toThrow();
  expect(() => safeFileName("..")).toThrow();
  expect(safeFileName("notes.md")).toBe("notes.md");
  expect(safeFileName("a/b/c.txt")).toBe("c.txt");
});

test("runHandoff never awaits claude (fire-and-forget): spawns only `open`", async () => {
  const h = harness();
  await runHandoff({ target: "claude", context: "x" }, h.opts);
  // 唯一的 spawn 是 open；claude 不由 daemon 直接 spawn（它住在 .command 脚本里）
  expect(h.spawns.every((s) => s.cmd === "open")).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/handoff.test.ts`
Expected: FAIL —— `../src/handoff` 不存在

- [ ] **Step 3: 写实现（`daemon/src/handoff.ts`）**

```ts
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { HandoffParams, HandoffResult } from "../../src/types/local-bridge";
import type { SpawnFn } from "./run-local-agent";
import { paths } from "./paths";
import { log } from "./log";

/** 我们在 handoff 目录里写死的文件名——用户传的文件不许撞它们。 */
const RESERVED = new Set(["context.md", "start.command"]);

/** slug：context 前 24 字符小写、非字母数字转 -。 */
function slugify(context: string): string {
  return (
    context.slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "handoff"
  );
}

/**
 * 用户（被 untrusted 页面驱动的 LLM）传来的文件名一律取 basename：剥掉任何目录
 * 成分（`../` 遍历被中和成落在 handoff 目录内的裸名），并挡掉空名 / . / .. / 保留名。
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  if (!base || base === "." || base === ".." || RESERVED.has(base)) {
    throw new Error(`unsafe file name: ${JSON.stringify(name)}`);
  }
  return base;
}

const realSpawn: SpawnFn = async (cmd, args, cwd) => {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, exitCode, stderr };
};

export async function runHandoff(
  params: HandoffParams,
  opts?: {
    spawn?: SpawnFn;
    ensureDir?: (dir: string) => void;
    writeFile?: (path: string, content: string, mode?: number) => void;
    now?: () => string;
  },
): Promise<HandoffResult> {
  const spawn = opts?.spawn ?? realSpawn;
  const ensureDir = opts?.ensureDir ?? ((d) => mkdirSync(d, { recursive: true }));
  const writeFile =
    opts?.writeFile ?? ((p, c, m) => writeFileSync(p, c, m != null ? { mode: m } : undefined));
  const now = opts?.now ?? (() => new Date().toISOString().slice(0, 10));

  const dir = join(paths.handoffsDir, `${now()}-${slugify(params.context)}`);
  ensureDir(dir);
  writeFile(join(dir, "context.md"), params.context);
  for (const f of params.files ?? []) {
    writeFile(join(dir, safeFileName(f.name)), f.content);
  }
  // 交互式会话脚本：cd 进目录、用初始 prompt 拉起 claude。**不带**
  // --dangerously-skip-permissions —— 人就在终端前，claude 自己的交互审批有人可批，
  // 这正是 hand-off 区别于 round-trip 的地方。exec 让 claude 接管终端；退出后
  // Terminal 显示 process completed，错误（如 claude 未装）对用户可见。
  // dir 是 daemon 派生（homedir + [a-z0-9-] slug），非 raw 用户输入 → 无命令注入；
  // JSON.stringify 的引号处理兼容 bash 双引号（含路径空格）。
  const cmd = params.target; // Slice 1 只 claude
  const script =
    `#!/bin/bash\n` +
    `cd ${JSON.stringify(dir)} || exit 1\n` +
    `exec ${cmd} "Read context.md in this directory for the handed-off context, then continue the task."\n`;
  const scriptPath = join(dir, "start.command");
  writeFile(scriptPath, script, 0o755);
  log("info", "handoff.open", { dir, target: cmd, files: (params.files ?? []).length });
  // macOS `open` 双击 .command → 默认 Terminal.app 跑它 → 交互式会话。
  // fire-and-forget：open 启动终端后立刻退，不等 claude。
  await spawn("open", [scriptPath], dir);
  return { dir };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test test/handoff.test.ts`
Expected: PASS（4 测试全绿）

- [ ] **Step 5: daemon 路由（`daemon/src/daemon.ts`）**

在 import 区加：
```ts
import { runHandoff } from "./handoff";
```
在 `import type { BridgeResponse, RunLocalAgentParams }` 那行把 `HandoffParams` 并进去：
```ts
import type { BridgeResponse, RunLocalAgentParams, HandoffParams } from "../../src/types/local-bridge";
```
在 `switch (msg.method)` 里、`run_local_agent` case 之后加：
```ts
    case "handoff_to_agent": {
      try {
        const result = await runHandoff(msg.params as HandoffParams);
        return respond({ ok: true, result });
      } catch (e) {
        log("error", "handoff.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "handoff_failed", message: String(e) } });
      }
    }
```

- [ ] **Step 6: 跑整个 daemon 测试套件确认无回归**

Run: `cd daemon && bun test`
Expected: PASS（Slice 0 的 24 测试 + 本 task 新增全绿）

- [ ] **Step 7: 提交**

```bash
git add daemon/src/handoff.ts daemon/test/handoff.test.ts daemon/src/daemon.ts
git commit -m "feat(daemon): runHandoff executor + handoff_to_agent routing"
```

---

## Task 3: 扩展侧 `requestHandoff`

**Files:**
- Modify: `src/background/local-bridge.ts`
- Test: `src/background/local-bridge.test.ts`

**Interfaces:**
- Consumes: `HandoffParams` / `HandoffResult`（Task 1）、现有 `send` / `initLocalBridge`
- Produces: `requestHandoff(params: HandoffParams): Promise<HandoffResult>`

- [ ] **Step 1: 写失败测试（`src/background/local-bridge.test.ts`，在 describe 内追加）**

```ts
  it("requestHandoff resolves on matching id with the handoff dir", async () => {
    const { initLocalBridge, requestHandoff } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent"] },
    });

    const p = requestHandoff({ target: "claude", context: "do the thing" });
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    expect(req.method).toBe("handoff_to_agent");
    fakePort._emit({ id: req.id, ok: true, result: { dir: "/Users/x/pie-handoffs/2026-07-06-do-the-thing" } });
    await expect(p).resolves.toMatchObject({ dir: "/Users/x/pie-handoffs/2026-07-06-do-the-thing" });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/background/local-bridge.test.ts`
Expected: FAIL —— `requestHandoff` 未导出

- [ ] **Step 3: 写实现（`src/background/local-bridge.ts`）**

顶部 import 里把 `HandoffParams` / `HandoffResult` 并进 `@/types/local-bridge`：
```ts
import {
  PROTOCOL_VERSION,
  type BridgeRequest,
  type BridgeResponse,
  type RunLocalAgentParams,
  type RunLocalAgentResult,
  type HandoffParams,
  type HandoffResult,
} from "@/types/local-bridge";
```
在 `requestLocalAgent` 之后加：
```ts
export async function requestHandoff(params: HandoffParams): Promise<HandoffResult> {
  const r = await send("handoff_to_agent", params);
  return r as HandoffResult;
}
```
（`send` 的 `method: BridgeRequest["method"]` 已在 Task 1 并入 `handoff_to_agent`，无需再改签名。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/background/local-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/background/local-bridge.ts src/background/local-bridge.test.ts
git commit -m "feat(bridge): extension-side requestHandoff over the bridge"
```

---

## Task 4: `handoff_to_agent` 工具 + tool-names 登记

**Files:**
- Create: `src/lib/agent/tools/handoff.ts`
- Create: `src/lib/agent/tools/handoff.test.ts`
- Modify: `src/lib/agent/tool-names.ts`

**Interfaces:**
- Consumes: `Tool` / `ToolHandlerContext`（`../types`）、`ActionResult`、`HandoffParams` / `HandoffResult`
- Produces: `buildHandoffTool(deps: HandoffToolDeps): Tool`、`HandoffToolDeps { run: (p: HandoffParams) => Promise<HandoffResult>; requestConsent: (p: { context: string; target: string; fileCount: number }) => Promise<boolean> }`

- [ ] **Step 1: 先登记 tool-names（`src/lib/agent/tool-names.ts`），否则构建期不变量会拦**

`LOCAL_BRIDGE_TOOL_NAMES` 改为：
```ts
export const LOCAL_BRIDGE_TOOL_NAMES = ["run_local_agent", "handoff_to_agent"] as const;
```
`TOOL_CLASSES` 里 `run_local_agent: "write",` 之后加：
```ts
  // hand-off：建目录 / 落盘 / 唤起本地交互式会话——本地写动作。
  handoff_to_agent: "write",
```
`TOOL_GROUPS` 里 `run_local_agent: "core",` 之后加：
```ts
  handoff_to_agent: "core",
```

- [ ] **Step 2: 写失败测试（`src/lib/agent/tools/handoff.test.ts`）**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildHandoffTool } from "./handoff";

describe("handoff_to_agent tool", () => {
  it("declines: consent false → error, run not called", async () => {
    const run = vi.fn();
    const tool = buildHandoffTool({ run, requestConsent: async () => false });
    const r = await tool.handler({ context: "do it" }, {} as any);
    expect(r.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("grants: run called, observation carries the handoff dir path", async () => {
    const run = vi.fn(async () => ({ dir: "/Users/x/pie-handoffs/2026-07-06-do-it" }));
    const consent = vi.fn(async () => true);
    const tool = buildHandoffTool({ run, requestConsent: consent });
    const r = await tool.handler({ context: "do it", files: [{ name: "a.md", content: "x" }] }, {} as any);
    expect(consent).toHaveBeenCalledWith({ context: "do it", target: "claude", fileCount: 1 });
    expect(run).toHaveBeenCalledWith({ target: "claude", context: "do it", files: [{ name: "a.md", content: "x" }] });
    expect(r.success).toBe(true);
    expect(r.observation).toContain("/Users/x/pie-handoffs/2026-07-06-do-it");
  });

  it("rejects empty context", async () => {
    const tool = buildHandoffTool({ run: vi.fn(), requestConsent: vi.fn() });
    const r = await tool.handler({ context: "   " }, {} as any);
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/handoff.test.ts`
Expected: FAIL —— `./handoff` 不存在

- [ ] **Step 4: 写实现（`src/lib/agent/tools/handoff.ts`）**

```ts
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { HandoffParams, HandoffResult } from "@/types/local-bridge";

export interface HandoffToolDeps {
  run: (p: HandoffParams) => Promise<HandoffResult>;
  /** HITL 授权卡：展示 context + target + 文件数原文，返回是否放行。 */
  requestConsent: (p: { context: string; target: string; fileCount: number }) => Promise<boolean>;
}

export function buildHandoffTool(deps: HandoffToolDeps): Tool {
  return {
    name: "handoff_to_agent",
    description:
      "Hand OFF an open-ended, interactive task to the user's local Claude Code in a real terminal " +
      "session. Unlike run_local_agent (which BLOCKS and returns output), this is FIRE-AND-FORGET: it " +
      "writes your context to context.md, stages any files you provide, and opens an interactive " +
      "terminal where the user's local agent continues the work WITH THE HUMAN PRESENT. Use for " +
      "open-ended / collaborative / long-running work that a blocking headless call can't handle. You " +
      "get back ONLY the handoff directory path — results are NOT returned to you. Requires user " +
      "authorization each call.",
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
      const granted = await deps.requestConsent({
        context: a.context,
        target: "claude",
        fileCount: files?.length ?? 0,
      });
      if (!granted) {
        return { success: false, error: "User declined the hand-off." };
      }
      const result = await deps.run({ target: "claude", context: a.context, files });
      // fire-and-forget：无 untrusted 内容回传。dir 是 daemon 派生路径（可信），
      // 直接作 trusted observation 让 LLM 转述给用户去那个终端接着干。
      return {
        success: true,
        observation:
          `Handed off to the user's local Claude Code. An interactive terminal session was opened at:\n` +
          `${result.dir}\n` +
          `This is fire-and-forget — the local agent continues independently with the user; ` +
          `results are NOT returned here.`,
      };
    },
  };
}
```

- [ ] **Step 5: 跑测试确认通过 + 构建期不变量不 throw**

Run: `pnpm test src/lib/agent/tools/handoff.test.ts src/lib/agent/tool-names.test.ts`
Expected: PASS（tool-names 若漏登记会在 import 时 throw，此步一并守住）

- [ ] **Step 6: 提交**

```bash
git add src/lib/agent/tools/handoff.ts src/lib/agent/tools/handoff.test.ts src/lib/agent/tool-names.ts
git commit -m "feat(agent): handoff_to_agent tool + tool-names registration"
```

---

## Task 5: `HandoffCard` 授权卡 + panel-request kind + i18n + Chat 渲染

**Files:**
- Modify: `src/lib/panel-request.ts`
- Create: `src/sidepanel/components/HandoffCard.tsx`
- Create: `src/sidepanel/components/HandoffCard.test.tsx`
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts`
- Modify: `src/sidepanel/components/Chat.tsx`

**Interfaces:**
- Consumes: `useT`、`PanelRequestMap`、现有 `respondPanel` / `panelRequest`（Chat.tsx）
- Produces: `PanelRequestMap["handoff-to-agent"] = { req: { context: string; target: string; fileCount: number }; res: boolean }`、`HandoffCard({ payload, onDecision })`

- [ ] **Step 1: panel-request kind（`src/lib/panel-request.ts`）**

`PanelRequestMap` 里 `"run-local-agent"` 那行之后加：
```ts
  "handoff-to-agent": { req: { context: string; target: string; fileCount: number }; res: boolean };
```

- [ ] **Step 2: 六份字典加 `handoff` 文案块**

在**每份** `src/lib/i18n/dictionaries/*.ts` 的 `runLocalAgent: { ... }` 块之后加对应语言的 `handoff` 块。英文（`en.ts`）：
```ts
  handoff: {
    title: "Hand off to a local agent (interactive)?",
    targetLabel: "Local agent",
    contextLabel: "Context",
    filesLabel: "Files to stage",
    allow: "Hand off",
    deny: "Cancel",
  },
```
`zh-CN.ts`：
```ts
  handoff: {
    title: "交棒给本地 Agent（交互式）？",
    targetLabel: "本地 Agent",
    contextLabel: "上下文",
    filesLabel: "随交棒文件",
    allow: "交棒",
    deny: "取消",
  },
```
`zh-TW.ts`：
```ts
  handoff: {
    title: "交棒給本地 Agent（互動式）？",
    targetLabel: "本地 Agent",
    contextLabel: "上下文",
    filesLabel: "隨交棒檔案",
    allow: "交棒",
    deny: "取消",
  },
```
`es-419.ts`：
```ts
  handoff: {
    title: "¿Delegar a un agente local (interactivo)?",
    targetLabel: "Agente local",
    contextLabel: "Contexto",
    filesLabel: "Archivos a preparar",
    allow: "Delegar",
    deny: "Cancelar",
  },
```
`ja.ts`：
```ts
  handoff: {
    title: "ローカルエージェントに引き継ぐ（対話型）？",
    targetLabel: "ローカルエージェント",
    contextLabel: "コンテキスト",
    filesLabel: "引き継ぐファイル",
    allow: "引き継ぐ",
    deny: "キャンセル",
  },
```
`pt-BR.ts`：
```ts
  handoff: {
    title: "Repassar para um agente local (interativo)?",
    targetLabel: "Agente local",
    contextLabel: "Contexto",
    filesLabel: "Arquivos a preparar",
    allow: "Repassar",
    deny: "Cancelar",
  },
```

- [ ] **Step 3: 跑 parity 测试确认 6 份对齐**

Run: `pnpm test dictionary-parity`
Expected: PASS（键在 6 份字典全对齐；漏一份即挂）

- [ ] **Step 4: 写卡片失败测试（`src/sidepanel/components/HandoffCard.test.tsx`）**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HandoffCard } from "./HandoffCard";

describe("HandoffCard", () => {
  it("renders context verbatim + file count, wires decisions", () => {
    const onDecision = vi.fn();
    render(
      <HandoffCard
        payload={{ context: "REFACTOR THE THING", target: "claude", fileCount: 2 }}
        onDecision={onDecision}
      />,
    );
    expect(screen.getByText("REFACTOR THE THING")).toBeInTheDocument();
    expect(screen.getByText(/2/)).toBeInTheDocument(); // 文件数可见
    fireEvent.click(screen.getByText("Hand off"));
    expect(onDecision).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 5: 跑确认失败**

Run: `pnpm test src/sidepanel/components/HandoffCard.test.tsx`
Expected: FAIL —— `./HandoffCard` 不存在

- [ ] **Step 6: 写卡片（`src/sidepanel/components/HandoffCard.tsx`，镜像 `RunLocalAgentCard`）**

```tsx
import { useT } from "@/lib/i18n";

interface Props {
  payload: { context: string; target: string; fileCount: number };
  onDecision: (ok: boolean) => void;
}

/**
 * Authorization gate shown before the SW hands a task OFF to a local interactive
 * agent session (opens a real terminal). Context is rendered verbatim so the user
 * sees exactly what will be written to context.md — mirrors RunLocalAgentCard.
 */
export function HandoffCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("handoff.title")}</div>
      <div>
        <div className="text-warning/70">{t("handoff.targetLabel")}</div>
        <code className="mt-1 block break-all rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning">
          {payload.target}
        </code>
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
          onClick={() => onDecision(true)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("handoff.allow")}
        </button>
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("handoff.deny")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: 跑卡片测试确认通过**

Run: `pnpm test src/sidepanel/components/HandoffCard.test.tsx`
Expected: PASS

- [ ] **Step 8: Chat.tsx 渲染卡片**

`src/sidepanel/components/Chat.tsx` 顶部 import 区（`RunLocalAgentCard` import 之后）加：
```ts
import { HandoffCard } from "./HandoffCard";
```
在 `panelRequest?.kind === "run-local-agent"` 那个 block 之后加：
```tsx
      {panelRequest?.kind === "handoff-to-agent" && (
        <HandoffCard
          payload={panelRequest.payload as { context: string; target: string; fileCount: number }}
          onDecision={(ok) => respondPanel(panelRequest.requestId, { ok: true, data: ok })}
        />
      )}
```

- [ ] **Step 9: typecheck + 相关测试通过**

Run: `pnpm typecheck && pnpm test src/sidepanel/components/HandoffCard.test.tsx dictionary-parity`
Expected: 0 错 + PASS

- [ ] **Step 10: 提交**

```bash
git add src/lib/panel-request.ts src/sidepanel/components/HandoffCard.tsx src/sidepanel/components/HandoffCard.test.tsx src/lib/i18n/dictionaries/ src/sidepanel/components/Chat.tsx
git commit -m "feat(sidepanel): HandoffCard consent + panel-request kind + i18n + Chat render"
```

---

## Task 6: loop 条件装配（capability-gated）+ 全量验证

**Files:**
- Modify: `src/lib/agent/loop.ts`

**Interfaces:**
- Consumes: `buildHandoffTool`（Task 4）、`requestHandoff`、`bridgeCapabilities`（Task 3 / Slice 0）、`requestFromPanel`、`isBridgeReady`

- [ ] **Step 1: 装配（`src/lib/agent/loop.ts`）**

顶部 import 补齐：
```ts
import { isBridgeReady, bridgeCapabilities, requestLocalAgent, requestHandoff } from "@/background/local-bridge";
import { buildRunLocalAgentTool } from "./tools/local-agent";
import { buildHandoffTool } from "./tools/handoff";
```
把现有 `localBridgeTools` 装配（约 line 1887）改为在 `run_local_agent` 之外、按 capability 追加 hand-off：
```ts
      const localBridgeTools = isBridgeReady()
        ? [
            buildRunLocalAgentTool({
              run: (p) => requestLocalAgent(p),
              requestConsent: (p) =>
                requestFromPanel(sessionId, "run-local-agent", { prompt: p.prompt, cwd: p.cwd }),
            }),
            // hand-off 门禁在 daemon 声明的能力上（spec §7 能力交集降级）：新扩展对旧
            // daemon（Slice 0，不报 handoff_to_agent）时不装配此工具，静默降级。
            ...(bridgeCapabilities().includes("handoff_to_agent")
              ? [
                  buildHandoffTool({
                    run: (p) => requestHandoff(p),
                    requestConsent: (p) => requestFromPanel(sessionId, "handoff-to-agent", p),
                  }),
                ]
              : []),
          ]
        : [];
```
（`...localBridgeTools` 已在 `fullToolList` 里 spread，无需改那行。）

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 错

- [ ] **Step 3: 全量测试套件**

Run: `pnpm test`
Expected: PASS（Slice 0 全绿基线 + 本 slice 新增；无回归）

- [ ] **Step 4: daemon 测试套件**

Run: `cd daemon && bun test`
Expected: PASS

- [ ] **Step 5: 构建（构建期不变量在此兜底）**

Run: `pnpm build`
Expected: 成功（`tool-names.ts` 的 `TOOL_CLASSES` / `TOOL_GROUPS` 不变量若漏登记会在此 throw）

- [ ] **Step 6: 提交**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(agent): assemble handoff_to_agent tool into loop (capability-gated)"
```

- [ ] **Step 7: 真机手测清单（合并前，非 CI）**

1. 主目录 `git checkout feat/local-bridge-slice1 && pnpm build`，`chrome://extensions` 刷新
2. 重装/重启 daemon（新二进制含 `handoff_to_agent`）：`cd daemon && bun build --compile ... && <安装脚本>`；`pie doctor` 确认双版本兼容
3. 设置页开「本地打通」开关 → 状态「已连接」
4. 侧栏发一个任务，诱导 LLM 调 `handoff_to_agent`（如「把这个页面的分析交棒给本地 Claude Code 继续」）→ 出 `HandoffCard`（context 原文可见）→ 点「交棒」
5. **验证**：`~/pie-handoffs/<date>-<slug>/` 建出，含 `context.md` + `start.command`；Terminal.app 自动弹出、cd 进该目录、交互式 claude 起来（无 skip-permissions，claude 正常问权限）；侧栏 observation 显示目录路径
6. **降级**：停 daemon → 工具从列表消失；换回 Slice 0 daemon（旧二进制）→ `handoff_to_agent` 不装配、`run_local_agent` 仍在（capability 交集降级）

---

## Self-Review

**Spec 覆盖**：
- §4.3 hand-off（`handoff_to_agent(target, context, files)` → HITL 卡 → 建 `~/pie-handoffs/<date>-<slug>/` 落 `context.md` + 文件 → 唤起交互式 session → 侧栏路径卡，fire-and-forget 不回传）→ Task 2（daemon）+ Task 4（工具）+ Task 5（卡）+ Task 6（装配）✅。侧栏「已交棒 + 路径」以工具 observation 承载（deferred 独立完成卡，见 Global Constraints）。
- §6.1 授权矩阵（hand-off 交互式 = HITL 卡、**不持久**）→ Task 4 每次 `requestConsent`、无 grant 写入 ✅。
- §6.2 wrapper：hand-off 不回传内容 → 本 slice 不新增 `untrusted_*`，符合 fire-and-forget，无 dual-list 改动 ✅。
- §7 版本漂移（能力交集降级）→ Task 6 `bridgeCapabilities().includes("handoff_to_agent")` 门禁 ✅。
- Trust boundary（`files[].name` 来自 untrusted-driven LLM）→ Task 2 `safeFileName` basename + reject 保留名/遍历 ✅。
- 交互式 ≠ headless：hand-off **不带** `--dangerously-skip-permissions`（Task 2 脚本 + 测试断言）✅。

**Placeholder 扫描**：无 TBD / "add error handling" / "similar to Task N"——每步含完整代码/命令/预期。

**类型一致性**：`HandoffParams`/`HandoffResult`（Task 1）→ `runHandoff`（T2）/ `requestHandoff`（T3）/ `buildHandoffTool.run`（T4）/ loop `requestHandoff`（T6）签名一致；`requestConsent` payload `{ context, target, fileCount }` 在 T4 工具、T5 panel-request kind、T5 卡 props、T6 `requestFromPanel` 四处一致；`handoff.title/targetLabel/contextLabel/filesLabel/allow/deny` 六键在字典（T5 Step2）与卡（T5 Step6）一致。
