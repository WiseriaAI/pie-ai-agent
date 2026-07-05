# Local Daemon Bridge — Slice 0（曳光弹）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端到端打通「Pie 侧栏发起 → 本地 daemon spawn `claude -p` → 结果回扩展 → 作 observation 回 agent loop」这一条最小链路，证明 native-messaging + 单二进制 host + unix socket daemon 这套管子通。

**Architecture:** 扩展 SW 经 `chrome.runtime.connectNative` 连一个薄 `pie host`（Chrome 按需 spawn），host 把 Chrome stdio framing ↔ 常驻 `pie daemon` 的 unix domain socket 双向透传。daemon 收 `run_local_agent` 请求 → spawn `claude -p` → 阻塞取 stdout → 回传。`run_local_agent` 工具只在 bridge 连通时才装配进 loop 的 tool 列表；调用前过 HITL 授权卡（展示 prompt + cwd 原文）。

**Tech Stack:** TypeScript；扩展侧 Vite + vitest；daemon 侧 **bun**（新引入，`daemon/` 子包，`bun test` + `bun build --compile` 出单二进制）；unix domain socket；macOS launchd + `.pkg`。

## Global Constraints

（逐条抄自 spec `docs/specs/2026-07-05-local-daemon-bridge.md`，每个 task 隐含遵守）

- **v1 只 macOS**：unix domain socket（非 named pipe）、launchd（非 systemd/schtasks）、`.pkg`（非 .msi）。Windows/Linux 分支代码本 slice 一律不写。
- **native host 名** = `ai.wiseria.pie`；host manifest `allowed_origins` 锁扩展 ID（`chrome-extension://<id>/`，唯一准入），无 token。
- **socket 路径** = `~/.pie/daemon.sock`，权限 `0600`。
- **`nativeMessaging` 进 `optional_permissions`**（非 `permissions`）——纯 BYOK 用户零感知，开启本地打通时才请求。
- **协议**：JSON-RPC 2.0 风格，双向 ndjson；`hello` 握手带 `protocolVersion`（整数）；类型权威源 `src/types/local-bridge.ts`，daemon 相对 import，**不复制**。
- **降级不硬挂**：daemon 未连通时 `run_local_agent` **不进 tool 列表**（LLM 看不到，不幻觉）；扩展离开 daemon 100% 完整可用。
- **授权卡展示原文**：`run_local_agent` 的 prompt + cwd 一律原文进卡，不经 LLM 转述。round-trip **每次弹卡、不持久**（Slice 0 不做任何 grant 持久化）。
- **cwd 默认临时 workspace** `~/pie-handoffs/<slug>/`；真实项目目录必须显式传 `cwd` 且卡上可见。
- **构建期不变量**：新工具名必须在 `TOOL_CLASSES` + `TOOL_GROUPS`（`src/lib/agent/tool-names.ts`）登记，否则 module load throw。
- **提交前**：扩展侧改动跑 `pnpm test` + `pnpm typecheck`；daemon 侧改动跑 `cd daemon && bun test`。

**本 slice 明确不做（defer，spec §11 / 后续 slice）**：live 流式嵌套渲染（Slice 0 阻塞返回最终结果）、hand-off、skill 执行器、MCP 代理、反向 MCP、grant 持久化、daemon 自更新、`codex` target（只做 `claude`）、`stream-json` 解析。

---

## File Structure

**新建（daemon 侧，`daemon/` 子包）：**
- `daemon/package.json` — bun 包清单
- `daemon/tsconfig.json` — 相对 import 扩展 `src/types/local-bridge.ts`
- `daemon/src/cli.ts` — `pie` 入口，路由 `daemon` / `host` / `doctor` 子命令
- `daemon/src/daemon.ts` — socket server + 请求分发（`hello` / `run_local_agent`）
- `daemon/src/host.ts` — Chrome stdio framing ↔ socket 透传
- `daemon/src/doctor.ts` — 诊断
- `daemon/src/paths.ts` — `~/.pie` 路径常量（socket / handoffs / logs）
- `daemon/test/*.test.ts` — bun 测试

**新建（扩展侧）：**
- `src/types/local-bridge.ts` — 协议类型 + `PROTOCOL_VERSION` 常量（**共享权威源**）
- `src/background/local-bridge.ts` — connectNative 生命周期 + `hello` + `isBridgeReady()` + `requestLocalAgent()`
- `src/lib/agent/tools/local-agent.ts` — `run_local_agent` 工具工厂
- `src/lib/agent/tools/local-agent.test.ts`
- `src/sidepanel/components/RunLocalAgentCard.tsx` — HITL 授权卡
- `src/background/local-bridge.test.ts`

**新建（打包）：**
- `daemon/install/ai.wiseria.pie.host.template.json` — native host manifest 模板
- `daemon/install/postinstall.sh` — `.pkg` postinstall（写 host manifest + 注册 launchd）
- `daemon/install/ai.wiseria.pie.plist.template` — launchd plist 模板
- `daemon/install/build-pkg.sh` — 打 `.pkg`

**修改：**
- `src/lib/agent/tool-names.ts` — 加 `LOCAL_BRIDGE_TOOL_NAMES` + 挂进 class/group 校验
- `src/lib/agent/loop.ts` — 条件装配 `run_local_agent` + 注入 requestFromPanel 卡
- `src/lib/panel-request.ts` — 加 `run-local-agent` kind
- `src/sidepanel/components/Chat.tsx` — 渲染 `RunLocalAgentCard`
- `manifest.json` — `optional_permissions: ["nativeMessaging"]`
- `.github/workflows/ci.yml`（若存在）— 加 bun daemon job

---

## Task 1: 协议类型 + PROTOCOL_VERSION 单一源

**Files:**
- Create: `src/types/local-bridge.ts`
- Test: `src/types/local-bridge.test.ts`

**Interfaces:**
- Produces: `PROTOCOL_VERSION: number`；`HelloRequest` / `HelloResponse` / `RunLocalAgentParams` / `RunLocalAgentResult` / `BridgeRequest` / `BridgeResponse` 类型；`BRIDGE_CAPABILITIES: readonly string[]`

- [ ] **Step 1: Write the failing test**

```typescript
// src/types/local-bridge.test.ts
import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  BRIDGE_CAPABILITIES,
  type BridgeRequest,
  type BridgeResponse,
} from "./local-bridge";

describe("local-bridge protocol", () => {
  it("PROTOCOL_VERSION is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("advertises run_local_agent capability", () => {
    expect(BRIDGE_CAPABILITIES).toContain("run_local_agent");
  });

  it("request/response carry a correlation id", () => {
    const req: BridgeRequest = {
      id: "abc",
      method: "run_local_agent",
      params: { target: "claude", prompt: "hi" },
    };
    const res: BridgeResponse = { id: "abc", ok: true, result: { output: "hi" } };
    expect(req.id).toBe(res.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/types/local-bridge.test.ts`
Expected: FAIL — `Cannot find module './local-bridge'`

- [ ] **Step 3: Write the types module**

```typescript
// src/types/local-bridge.ts
// 扩展 ↔ daemon 桥协议。此文件是唯一权威源；daemon 相对 import，不复制。
// 加字段只增不改语义；破坏性变更才 bump PROTOCOL_VERSION（spec §7）。

export const PROTOCOL_VERSION = 1;

/** daemon 声明它能处理的方法。扩展按此决定装配哪些本地工具。 */
export const BRIDGE_CAPABILITIES = ["run_local_agent"] as const;
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];

// ── 握手 ──────────────────────────────────────────────────────────────
export interface HelloRequest {
  id: string;
  method: "hello";
  params: { protocolVersion: number };
}
export interface HelloResponse {
  id: string;
  ok: true;
  result: { protocolVersion: number; capabilities: string[] };
}

// ── run_local_agent ──────────────────────────────────────────────────
export interface RunLocalAgentParams {
  target: "claude"; // Slice 0 只 claude；codex 后续 slice
  prompt: string;
  /** 缺省 = daemon 建的临时 workspace ~/pie-handoffs/<slug>/ */
  cwd?: string;
}
export interface RunLocalAgentResult {
  output: string;
  exitCode: number;
  /** daemon 实际使用的 cwd（回填给卡片/audit） */
  cwd: string;
}

// ── 通用信封 ──────────────────────────────────────────────────────────
export interface BridgeRequest {
  id: string;
  method: "hello" | "run_local_agent";
  params: unknown;
}
export type BridgeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/types/local-bridge.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/types/local-bridge.ts src/types/local-bridge.test.ts
git commit -m "feat(bridge): protocol types + PROTOCOL_VERSION single source"
```

---

## Task 2: daemon 子包脚手架 + `pie` CLI 路由

**Files:**
- Create: `daemon/package.json`, `daemon/tsconfig.json`, `daemon/src/cli.ts`, `daemon/src/paths.ts`, `daemon/src/doctor.ts`
- Test: `daemon/test/cli.test.ts`

**Interfaces:**
- Produces: `runCli(argv: string[]): Promise<number>`（返回 exit code）；`paths.socketPath` / `paths.pieDir` / `paths.handoffsDir`；`doctor(): Promise<{ ok: boolean; lines: string[] }>`

- [ ] **Step 1: 建 bun 子包清单与 tsconfig**

```jsonc
// daemon/package.json
{
  "name": "pie-daemon",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "compile": "bun build ./src/cli.ts --compile --outfile dist/pie"
  }
}
```

```jsonc
// daemon/tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ESNext",
    "types": ["bun-types"],
    "paths": { "@shared/*": ["../src/types/*"] }
  },
  "include": ["src", "test", "../src/types/local-bridge.ts"]
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// daemon/test/cli.test.ts
import { test, expect } from "bun:test";
import { runCli } from "../src/cli";

test("unknown subcommand returns non-zero", async () => {
  const code = await runCli(["bogus"]);
  expect(code).not.toBe(0);
});

test("doctor subcommand runs and returns 0 or 1", async () => {
  const code = await runCli(["doctor"]);
  expect([0, 1]).toContain(code);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd daemon && bun test test/cli.test.ts`
Expected: FAIL — cannot resolve `../src/cli`

- [ ] **Step 4: 写 paths + doctor + cli**

```typescript
// daemon/src/paths.ts
import { homedir } from "os";
import { join } from "path";

const pieDir = join(homedir(), ".pie");
export const paths = {
  pieDir,
  socketPath: join(pieDir, "daemon.sock"),
  handoffsDir: join(homedir(), "pie-handoffs"),
  logsDir: join(pieDir, "logs"),
};
```

```typescript
// daemon/src/doctor.ts
import { existsSync } from "fs";
import { paths } from "./paths";

export async function doctor(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const socketExists = existsSync(paths.socketPath);
  lines.push(`socket ${paths.socketPath}: ${socketExists ? "present" : "absent (daemon not running?)"}`);
  const claude = Bun.which("claude");
  lines.push(`claude CLI: ${claude ?? "NOT FOUND on PATH"}`);
  const ok = socketExists && claude != null;
  return { ok, lines };
}
```

```typescript
// daemon/src/cli.ts
import { doctor } from "./doctor";

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case "daemon": {
      const { startDaemon } = await import("./daemon");
      await startDaemon();
      return 0; // 常驻，正常不返回
    }
    case "host": {
      const { runHost } = await import("./host");
      await runHost();
      return 0;
    }
    case "doctor": {
      const r = await doctor();
      for (const l of r.lines) console.error(l);
      return r.ok ? 0 : 1;
    }
    default:
      console.error(`unknown command: ${cmd ?? "(none)"}. usage: pie <daemon|host|doctor>`);
      return 2;
  }
}

if (import.meta.main) {
  runCli(Bun.argv.slice(2)).then((code) => process.exit(code));
}
```

注：`cli.ts` 动态 `import("./daemon")` / `import("./host")`，这俩在 Task 3/5 建；本 task 先建 stub 让 typecheck 过——建 `daemon/src/daemon.ts` 内 `export async function startDaemon(): Promise<void> {}` 与 `daemon/src/host.ts` 内 `export async function runHost(): Promise<void> {}` 空壳，Task 3/5 填实现。

- [ ] **Step 5: Run test to verify it passes**

Run: `cd daemon && bun test test/cli.test.ts`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
git add daemon/package.json daemon/tsconfig.json daemon/src/cli.ts daemon/src/paths.ts daemon/src/doctor.ts daemon/src/daemon.ts daemon/src/host.ts daemon/test/cli.test.ts
git commit -m "feat(daemon): bun package scaffold + pie CLI routing + doctor"
```

---

## Task 3: daemon socket server + `hello` 握手

**Files:**
- Modify: `daemon/src/daemon.ts`
- Test: `daemon/test/daemon.test.ts`

**Interfaces:**
- Consumes: `paths.socketPath`（Task 2）；`PROTOCOL_VERSION` / `BRIDGE_CAPABILITIES` / `HelloResponse`（`@shared/local-bridge`，即 `../src/types/local-bridge`）
- Produces: `startDaemon(): Promise<void>`（监听 socket）；`handleMessage(line: string): Promise<string>`（纯函数，单条 ndjson in → 单条 ndjson out，供测试直接调）

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/daemon.test.ts
import { test, expect } from "bun:test";
import { handleMessage } from "../src/daemon";
import { PROTOCOL_VERSION } from "../../src/types/local-bridge";

test("hello returns protocolVersion + capabilities", async () => {
  const out = await handleMessage(
    JSON.stringify({ id: "1", method: "hello", params: { protocolVersion: PROTOCOL_VERSION } }),
  );
  const res = JSON.parse(out);
  expect(res.id).toBe("1");
  expect(res.ok).toBe(true);
  expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(res.result.capabilities).toContain("run_local_agent");
});

test("unknown method returns structured error", async () => {
  const out = await handleMessage(JSON.stringify({ id: "2", method: "nope", params: {} }));
  const res = JSON.parse(out);
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe("unknown_method");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/daemon.test.ts`
Expected: FAIL — `handleMessage` is not exported / is the empty stub

- [ ] **Step 3: 实现 handleMessage + startDaemon**

```typescript
// daemon/src/daemon.ts
import { unlinkSync, existsSync, mkdirSync, chmodSync } from "fs";
import { PROTOCOL_VERSION, BRIDGE_CAPABILITIES } from "../../src/types/local-bridge";
import type { BridgeResponse } from "../../src/types/local-bridge";
import { paths } from "./paths";
import { runLocalAgent } from "./run-local-agent"; // Task 4

export async function handleMessage(line: string): Promise<string> {
  let msg: { id?: string; method?: string; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return JSON.stringify({ id: "", ok: false, error: { code: "bad_json", message: "invalid JSON" } });
  }
  const id = msg.id ?? "";
  const respond = (r: Omit<BridgeResponse, "id">): string => JSON.stringify({ id, ...r });

  switch (msg.method) {
    case "hello":
      return respond({
        ok: true,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: [...BRIDGE_CAPABILITIES] },
      });
    case "run_local_agent": {
      try {
        const result = await runLocalAgent(msg.params as never);
        return respond({ ok: true, result });
      } catch (e) {
        return respond({ ok: false, error: { code: "run_failed", message: String(e) } });
      }
    }
    default:
      return respond({ ok: false, error: { code: "unknown_method", message: String(msg.method) } });
  }
}

export async function startDaemon(): Promise<void> {
  if (!existsSync(paths.pieDir)) mkdirSync(paths.pieDir, { recursive: true });
  if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath); // 清残留
  Bun.listen({
    unix: paths.socketPath,
    socket: {
      data(socket, data) {
        const text = data.toString();
        for (const line of text.split("\n").filter(Boolean)) {
          handleMessage(line).then((out) => socket.write(out + "\n"));
        }
      },
    },
  });
  chmodSync(paths.socketPath, 0o600); // 用户级信任边界
  console.error(`[pie daemon] listening on ${paths.socketPath}`);
  await new Promise(() => {}); // 常驻
}
```

注：`import { runLocalAgent } from "./run-local-agent"` 在 Task 4 建。本 task 先建 `daemon/src/run-local-agent.ts` 空壳：`export async function runLocalAgent(): Promise<{output:string;exitCode:number;cwd:string}> { return { output: "", exitCode: 0, cwd: "" }; }` 让 typecheck 过。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/daemon.test.ts`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/daemon.ts daemon/src/run-local-agent.ts daemon/test/daemon.test.ts
git commit -m "feat(daemon): unix socket server + hello handshake"
```

---

## Task 4: daemon `run_local_agent`（spawn claude -p，阻塞取 stdout）

**Files:**
- Modify: `daemon/src/run-local-agent.ts`
- Test: `daemon/test/run-local-agent.test.ts`

**Interfaces:**
- Consumes: `RunLocalAgentParams` / `RunLocalAgentResult`（`@shared`）；`paths.handoffsDir`
- Produces: `runLocalAgent(params: RunLocalAgentParams, opts?: { spawn?: SpawnFn }): Promise<RunLocalAgentResult>`；`type SpawnFn`（可注入，测试用 stub 替真 claude）

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/run-local-agent.test.ts
import { test, expect } from "bun:test";
import { runLocalAgent } from "../src/run-local-agent";

test("spawns target with prompt, returns stdout", async () => {
  const fakeSpawn = async (cmd: string, args: string[], cwd: string) => {
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("hello world");
    return { stdout: "AGENT REPLY", exitCode: 0 };
  };
  const r = await runLocalAgent(
    { target: "claude", prompt: "hello world" },
    { spawn: fakeSpawn },
  );
  expect(r.output).toBe("AGENT REPLY");
  expect(r.exitCode).toBe(0);
  expect(r.cwd).toContain("pie-handoffs"); // 默认临时 workspace
});

test("honors explicit cwd", async () => {
  const fakeSpawn = async (_c: string, _a: string[], cwd: string) => {
    expect(cwd).toBe("/tmp/proj");
    return { stdout: "ok", exitCode: 0 };
  };
  const r = await runLocalAgent(
    { target: "claude", prompt: "x", cwd: "/tmp/proj" },
    { spawn: fakeSpawn },
  );
  expect(r.cwd).toBe("/tmp/proj");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/run-local-agent.test.ts`
Expected: FAIL — stub 实现返回空

- [ ] **Step 3: 实现 runLocalAgent**

```typescript
// daemon/src/run-local-agent.ts
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { RunLocalAgentParams, RunLocalAgentResult } from "../../src/types/local-bridge";
import { paths } from "./paths";

export type SpawnFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; exitCode: number }>;

const realSpawn: SpawnFn = async (cmd, args, cwd) => {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
};

/** slug from prompt: 前 24 字符小写、非字母数字转 -。ponytail: 无需时间戳（无 Date 依赖测试）。 */
function slugify(prompt: string): string {
  return prompt.slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "task";
}

export async function runLocalAgent(
  params: RunLocalAgentParams,
  opts?: { spawn?: SpawnFn },
): Promise<RunLocalAgentResult> {
  const spawn = opts?.spawn ?? realSpawn;
  let cwd = params.cwd;
  if (!cwd) {
    cwd = join(paths.handoffsDir, slugify(params.prompt));
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  }
  // Slice 0: 阻塞取 stdout（无 stream-json 解析，见 plan 顶部 defer）
  const { stdout, exitCode } = await spawn("claude", ["-p", params.prompt], cwd);
  return { output: stdout, exitCode, cwd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/run-local-agent.test.ts`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/run-local-agent.ts daemon/test/run-local-agent.test.ts
git commit -m "feat(daemon): run_local_agent spawns claude -p, blocking stdout"
```

---

## Task 5: `pie host` — Chrome stdio framing ↔ socket 透传

**Files:**
- Modify: `daemon/src/host.ts`
- Create: `daemon/src/framing.ts`
- Test: `daemon/test/framing.test.ts`

**Background — Chrome native messaging framing:** Chrome 在 host 的 stdin/stdout 上用 **4 字节小端 uint32 长度前缀 + UTF-8 JSON** 分帧。host 读 stdin 解帧 → 转 daemon socket（ndjson）→ 读 socket 回复 → 重新加长度前缀写 stdout。

**Interfaces:**
- Produces: `encodeFrame(obj: unknown): Uint8Array`；`decodeFrames(buf: Uint8Array): { messages: unknown[]; rest: Uint8Array }`；`runHost(): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/framing.test.ts
import { test, expect } from "bun:test";
import { encodeFrame, decodeFrames } from "../src/framing";

test("encode then decode round-trips", () => {
  const frame = encodeFrame({ hello: "world" });
  // 前 4 字节 = 长度
  const len = new DataView(frame.buffer).getUint32(0, true);
  expect(len).toBe(frame.byteLength - 4);
  const { messages, rest } = decodeFrames(frame);
  expect(messages).toEqual([{ hello: "world" }]);
  expect(rest.byteLength).toBe(0);
});

test("decode handles partial frame (keeps rest)", () => {
  const full = encodeFrame({ a: 1 });
  const partial = full.slice(0, full.byteLength - 2); // 缺尾 2 字节
  const { messages, rest } = decodeFrames(partial);
  expect(messages).toEqual([]);
  expect(rest.byteLength).toBe(partial.byteLength);
});

test("decode handles two concatenated frames", () => {
  const a = encodeFrame({ n: 1 });
  const b = encodeFrame({ n: 2 });
  const buf = new Uint8Array([...a, ...b]);
  const { messages } = decodeFrames(buf);
  expect(messages).toEqual([{ n: 1 }, { n: 2 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/framing.test.ts`
Expected: FAIL — cannot resolve `../src/framing`

- [ ] **Step 3: 实现 framing**

```typescript
// daemon/src/framing.ts
export function encodeFrame(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + json.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, true); // 小端
  out.set(json, 4);
  return out;
}

export function decodeFrames(buf: Uint8Array): { messages: unknown[]; rest: Uint8Array } {
  const messages: unknown[] = [];
  let offset = 0;
  while (buf.byteLength - offset >= 4) {
    const len = new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, true);
    if (buf.byteLength - offset - 4 < len) break; // 帧不全，留到下次
    const json = buf.slice(offset + 4, offset + 4 + len);
    messages.push(JSON.parse(new TextDecoder().decode(json)));
    offset += 4 + len;
  }
  return { messages, rest: buf.slice(offset) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/framing.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: 实现 runHost（透传，接线不单测，端到端在 Task 12 手测）**

```typescript
// daemon/src/host.ts
import { encodeFrame, decodeFrames } from "./framing";
import { paths } from "./paths";

// host 由 Chrome spawn；stdin=Chrome→host，stdout=host→Chrome。
// 每条帧 → daemon socket（ndjson）→ 回复 → 重新加帧写 stdout。
export async function runHost(): Promise<void> {
  const conn = await Bun.connect({
    unix: paths.socketPath,
    socket: {
      data(_s, data) {
        // socket 回复（ndjson）→ 加帧写 Chrome stdout
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const frame = encodeFrame(JSON.parse(line));
          Bun.write(Bun.stdout, frame);
        }
      },
    },
  });

  let buf = new Uint8Array(0);
  for await (const chunk of Bun.stdin.stream()) {
    buf = new Uint8Array([...buf, ...chunk]);
    const { messages, rest } = decodeFrames(buf);
    buf = rest;
    for (const msg of messages) conn.write(JSON.stringify(msg) + "\n");
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add daemon/src/framing.ts daemon/src/host.ts daemon/test/framing.test.ts
git commit -m "feat(host): Chrome stdio framing + socket passthrough"
```

---

## Task 6: 扩展 `local-bridge.ts` — connectNative + hello + isBridgeReady

**Files:**
- Create: `src/background/local-bridge.ts`
- Test: `src/background/local-bridge.test.ts`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION` / `BridgeResponse` / `RunLocalAgentParams` / `RunLocalAgentResult`（`@/types/local-bridge`）
- Produces:
  - `initLocalBridge(): void` — connectNative + hello，成功后置 ready
  - `isBridgeReady(): boolean` — 同步 getter，loop 装配时读
  - `requestLocalAgent(params: RunLocalAgentParams): Promise<RunLocalAgentResult>` — 发请求、按 id 等回

- [ ] **Step 1: Write the failing test**

```typescript
// src/background/local-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROTOCOL_VERSION } from "@/types/local-bridge";

// 一个可编程的假 native port
function makeFakePort() {
  const listeners: Array<(m: unknown) => void> = [];
  return {
    postMessage: vi.fn(),
    onMessage: { addListener: (cb: (m: unknown) => void) => listeners.push(cb) },
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
    _emit: (m: unknown) => listeners.forEach((cb) => cb(m)),
  };
}

describe("local-bridge", () => {
  let fakePort: ReturnType<typeof makeFakePort>;
  beforeEach(() => {
    vi.resetModules();
    fakePort = makeFakePort();
    (globalThis as any).chrome = {
      runtime: { connectNative: vi.fn(() => fakePort) },
    };
  });

  it("not ready before hello reply", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    expect(isBridgeReady()).toBe(false);
  });

  it("ready after hello reply with matching protocolVersion", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    // 抓 hello 请求，回 hello 响应
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent"] },
    });
    expect(isBridgeReady()).toBe(true);
  });

  it("requestLocalAgent resolves on matching id", async () => {
    const { initLocalBridge, requestLocalAgent } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({ id: helloReq.id, ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: [] } });

    const p = requestLocalAgent({ target: "claude", prompt: "hi" });
    const runReq = fakePort.postMessage.mock.calls[1][0] as { id: string };
    fakePort._emit({ id: runReq.id, ok: true, result: { output: "REPLY", exitCode: 0, cwd: "/tmp/x" } });
    await expect(p).resolves.toMatchObject({ output: "REPLY" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/background/local-bridge.test.ts`
Expected: FAIL — cannot resolve `./local-bridge`

- [ ] **Step 3: 实现 local-bridge**

```typescript
// src/background/local-bridge.ts
import {
  PROTOCOL_VERSION,
  type BridgeResponse,
  type RunLocalAgentParams,
  type RunLocalAgentResult,
} from "@/types/local-bridge";

const HOST_NAME = "ai.wiseria.pie";

let port: chrome.runtime.Port | null = null;
let ready = false;
let capabilities: string[] = [];
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function isBridgeReady(): boolean {
  return ready;
}
export function bridgeCapabilities(): string[] {
  return capabilities;
}

function send(method: string, params: unknown): Promise<unknown> {
  if (!port) return Promise.reject(new Error("bridge not connected"));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port!.postMessage({ id, method, params });
  });
}

export function initLocalBridge(): void {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    port = null; // 未装 daemon / 无 nativeMessaging 权限 → 静默降级
    return;
  }
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as BridgeResponse;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error.message));
  });
  port.onDisconnect.addListener(() => {
    ready = false;
    port = null;
    for (const p of pending.values()) p.reject(new Error("bridge disconnected"));
    pending.clear();
    // ponytail: Slice 0 不做指数退避重连；spec §8 的重连留后续 slice
  });
  // 握手
  send("hello", { protocolVersion: PROTOCOL_VERSION })
    .then((r) => {
      const res = r as { protocolVersion: number; capabilities: string[] };
      // 兼容窗口：差 ≤1 视为兼容（spec §7）
      if (Math.abs(res.protocolVersion - PROTOCOL_VERSION) <= 1) {
        capabilities = res.capabilities;
        ready = true;
      }
    })
    .catch(() => { ready = false; });
}

export async function requestLocalAgent(params: RunLocalAgentParams): Promise<RunLocalAgentResult> {
  const r = await send("run_local_agent", params);
  return r as RunLocalAgentResult;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/background/local-bridge.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/background/local-bridge.ts src/background/local-bridge.test.ts
git commit -m "feat(bridge): extension connectNative lifecycle + hello + requestLocalAgent"
```

---

## Task 7: `run_local_agent` 工具 + tool-names 登记

**Files:**
- Create: `src/lib/agent/tools/local-agent.ts`
- Modify: `src/lib/agent/tool-names.ts`
- Test: `src/lib/agent/tools/local-agent.test.ts`

**Interfaces:**
- Consumes: `RunLocalAgentResult`（`@/types/local-bridge`）；`Tool` / `ToolHandlerContext`（`../types`）
- Produces:
  - `buildRunLocalAgentTool(deps: RunLocalAgentToolDeps): Tool`
  - `interface RunLocalAgentToolDeps { run: (p: { target: "claude"; prompt: string; cwd?: string }) => Promise<RunLocalAgentResult>; requestConsent: (p: { prompt: string; cwd: string }) => Promise<boolean>; }`
  - `tool-names.ts`：`export const LOCAL_BRIDGE_TOOL_NAMES = ["run_local_agent"] as const;` + class=write + group=core

- [ ] **Step 1: 登记 tool-names（先让不变量就位）**

在 `src/lib/agent/tool-names.ts`：

1）在 `KNOWN_EDITOR_TOOL_NAMES` 之后加：
```typescript
// Local Daemon Bridge — round-trip 接力工具。仅当 bridge 连通时由 loop 条件装配
// 进 fullToolList（非 disclosure 门禁）。class=write：spawn 本地进程，是本地写动作
// （不碰 tab，故 R7 tab-lock 不触发，但 write 是诚实分类）。group=core：一旦在
// 列表里就总披露（存在性由 bridge 连通门禁，不靠 disclosure）。
export const LOCAL_BRIDGE_TOOL_NAMES = ["run_local_agent"] as const;
```

2）在 `TOOL_CLASSES` 里加 `run_local_agent: "write",`

3）在 `TOOL_GROUPS` 里加 `run_local_agent: "core",`

4）把两处 build-time 校验 loop 的数组从
```typescript
for (const name of [
  ...KNOWN_BUILT_IN_TOOL_NAMES,
  ...KNOWN_KEYBOARD_TOOL_NAMES,
  ...KNOWN_EDITOR_TOOL_NAMES,
]) {
```
改为额外 `...LOCAL_BRIDGE_TOOL_NAMES,`（**两个 loop 都改**：TOOL_CLASSES 校验 + TOOL_GROUPS 校验）。

- [ ] **Step 2: Write the failing test**

```typescript
// src/lib/agent/tools/local-agent.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildRunLocalAgentTool } from "./local-agent";

describe("run_local_agent tool", () => {
  it("denied consent → returns failure observation, does not run", async () => {
    const run = vi.fn();
    const tool = buildRunLocalAgentTool({
      run,
      requestConsent: async () => false,
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("granted consent → runs and returns output as observation", async () => {
    const run = vi.fn(async () => ({ output: "AGENT DID X", exitCode: 0, cwd: "/tmp/x" }));
    const tool = buildRunLocalAgentTool({
      run,
      requestConsent: async () => true,
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(run).toHaveBeenCalledWith({ target: "claude", prompt: "do it", cwd: undefined });
    expect(r.success).toBe(true);
    expect(r.observation).toContain("AGENT DID X");
  });

  it("missing prompt → validation error", async () => {
    const tool = buildRunLocalAgentTool({ run: vi.fn(), requestConsent: vi.fn() });
    const r = await tool.handler({}, { tabId: 1 } as never);
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/lib/agent/tools/local-agent.test.ts`
Expected: FAIL — cannot resolve `./local-agent`

- [ ] **Step 4: 实现工具**

```typescript
// src/lib/agent/tools/local-agent.ts
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { RunLocalAgentResult } from "@/types/local-bridge";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";

export interface RunLocalAgentToolDeps {
  run: (p: { target: "claude"; prompt: string; cwd?: string }) => Promise<RunLocalAgentResult>;
  /** HITL 授权卡：展示 prompt + cwd 原文，返回是否放行。 */
  requestConsent: (p: { prompt: string; cwd: string }) => Promise<boolean>;
}

export function buildRunLocalAgentTool(deps: RunLocalAgentToolDeps): Tool {
  return {
    name: "run_local_agent",
    description:
      "Hand a BOUNDED, non-interactive sub-task to the user's local Claude Code agent " +
      "(claude -p, headless) and get its final output back. Use for work that needs a full " +
      "local coding/analysis agent with filesystem + shell — e.g. run an analysis over exported " +
      "files, generate code, summarize a repo. The call BLOCKS until the local agent finishes and " +
      "returns its result. Requires user authorization each call. Do NOT use for open-ended " +
      "interactive coding (that is hand-off, a later capability).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task for the local agent." },
        cwd: {
          type: "string",
          description:
            "Optional working directory for the local agent. Defaults to a fresh temp workspace. " +
            "Only pass a real project path when the task must run there — the user sees this path on the authorization card.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { prompt?: unknown; cwd?: unknown };
      if (typeof a.prompt !== "string" || a.prompt.trim() === "") {
        return { success: false, error: "run_local_agent: `prompt` is required (non-empty string)." };
      }
      const cwd = typeof a.cwd === "string" ? a.cwd : undefined;
      const granted = await deps.requestConsent({ prompt: a.prompt, cwd: cwd ?? "(temp workspace)" });
      if (!granted) {
        return { success: false, error: "User declined to run the local agent." };
      }
      const result = await deps.run({ target: "claude", prompt: a.prompt, cwd });
      const ok = result.exitCode === 0;
      // daemon 输出是 untrusted（被读网页的 LLM 驱动）——先 escape 掉输出里任何伪造
      // 的 wrapper 标签，再包进 <untrusted_local_agent_output>，防突破边界。
      const safe = escapeUntrustedWrappers(result.output);
      return {
        success: ok,
        observation:
          `<untrusted_local_agent_output>\n${safe}\n</untrusted_local_agent_output>` +
          (ok ? "" : `\n(local agent exited ${result.exitCode})`),
        ...(ok ? {} : { error: `local agent exited ${result.exitCode}` }),
      };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/lib/agent/tools/local-agent.test.ts && pnpm typecheck`
Expected: PASS (3 passed) + typecheck 0 errors（含 tool-names 不变量不 throw）

- [ ] **Step 6: 登记 untrusted wrapper（多表 lock-step 不变量）**

1）在 `src/lib/agent/untrusted-wrappers.ts` 的 **master 表** `UNTRUSTED_WRAPPER_TAGS`（末尾，约 :59）加 `"untrusted_local_agent_output",`。

2）该 tag 必须同步进**每个内联 `WRAPPER_TAGS_LIST` 副本**的文件——现为 `src/lib/recording/capture.ts`、`src/lib/dom-actions/html-strip.ts`、`src/lib/dom-actions/probe-core.ts`。`src/lib/agent/untrusted-wrappers.test.ts` 的 **Scenario 8（dual-list lock-step）** 会为每个缺失的文件报红并点名，据此逐个补齐至绿。**不要**手猜文件清单——以该测试枚举的文件列表为准（测试顶部 line ~26 有权威文件数组）。

3）跑 `pnpm test src/lib/agent/untrusted-wrappers.test.ts` 确认 lock-step 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent/tools/local-agent.ts src/lib/agent/tools/local-agent.test.ts src/lib/agent/tool-names.ts src/lib/agent/untrusted-wrappers.ts src/lib/agent/page-snapshot.ts
git commit -m "feat(bridge): run_local_agent tool + tool-names/wrapper registration"
```

---

## Task 8: loop 条件装配 + HITL 卡接线

**Files:**
- Modify: `src/lib/panel-request.ts`（加 kind）
- Modify: `src/lib/agent/loop.ts`（条件装配 + requestFromPanel）
- Test: `src/lib/panel-request.test.ts`（加断言）

**Interfaces:**
- Consumes: `isBridgeReady` / `requestLocalAgent`（`@/background/local-bridge`，Task 6）；`buildRunLocalAgentTool`（Task 7）
- Produces: `PanelRequestMap` 加 `"run-local-agent": { req: { prompt: string; cwd: string }; res: boolean }`

- [ ] **Step 1: 加 panel-request kind + 测试**

在 `src/lib/panel-request.ts` 的 `PanelRequestMap` 加：
```typescript
"run-local-agent": { req: { prompt: string; cwd: string }; res: boolean };
```

在 `src/lib/panel-request.test.ts` 加：
```typescript
it("run-local-agent kind resolves boolean via handlePanelResponse", async () => {
  const port = makeFakePort(); // 复用文件内既有 helper
  registerPanelPort("s1", port as never);
  const p = requestFromPanel("s1", "run-local-agent", { prompt: "hi", cwd: "/tmp" });
  const sent = port.postMessage.mock.calls.at(-1)![0];
  handlePanelResponse(sent.requestId, { ok: true, data: true });
  await expect(p).resolves.toBe(true);
});
```
（若 `panel-request.test.ts` 无 `makeFakePort` helper，仿其既有 `cdp-consent` 测试的 port 构造方式。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/panel-request.test.ts`
Expected: FAIL（新增用例）或 typecheck 报 kind 不存在 → 加完 kind 后编译通过、用例转为红→绿

- [ ] **Step 3: loop 条件装配**

在 `src/lib/agent/loop.ts`：

1）顶部 import：
```typescript
import { isBridgeReady, requestLocalAgent } from "@/background/local-bridge";
import { buildRunLocalAgentTool } from "./tools/local-agent";
```

2）在 `fullToolList` 组装处（约 loop.ts:1879）之前构造条件工具，并 spread 进列表：
```typescript
const localBridgeTools = isBridgeReady()
  ? [
      buildRunLocalAgentTool({
        run: (p) => requestLocalAgent(p),
        requestConsent: (p) =>
          requestFromPanel(sessionId, "run-local-agent", { prompt: p.prompt, cwd: p.cwd }),
      }),
    ]
  : [];
const fullToolList = [
  ...BUILT_IN_TOOLS, ...mouseTools, ...keyboardTools, ...editorTools,
  readLocalFileTool, requestLocalFileTool, outputFileTool, ...scratchpadTools,
  loadToolsTool,
  ...localBridgeTools, // ← Slice 0
];
```

`requestFromPanel` 已在 loop.ts 作用域内（见 loop.ts:2391 schedule-model 用法），无需新 import。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/panel-request.test.ts && pnpm typecheck`
Expected: PASS + typecheck 0 errors

- [ ] **Step 5: loop 装配单测（bridge on/off 决定工具在不在）**

在 `src/lib/agent/loop.test.ts` 加（仿其既有 mock 风格；mock `@/background/local-bridge` 的 `isBridgeReady`）：
```typescript
it("run_local_agent 仅在 bridge ready 时出现在工具列表", async () => {
  // 断言：mock isBridgeReady→false 时 toolDefinitions 不含 run_local_agent；
  // →true 时含。具体接入点复用本文件既有「装配工具后断言 toolDefinitions」的用例结构。
});
```
（若 loop.test.ts 无现成「断言 toolDefinitions 名单」的钩子，此步降级为在 Task 7 的工具单测已覆盖工厂行为 + Task 12 手测覆盖装配，跳过此步并在 commit message 注明。ponytail: 不为断言硬凿 loop 内部导出。）

- [ ] **Step 6: Commit**

```bash
git add src/lib/panel-request.ts src/lib/panel-request.test.ts src/lib/agent/loop.ts src/lib/agent/loop.test.ts
git commit -m "feat(bridge): conditionally assemble run_local_agent + HITL card wiring"
```

---

## Task 9: 侧栏授权卡 `RunLocalAgentCard`

**Files:**
- Create: `src/sidepanel/components/RunLocalAgentCard.tsx`
- Modify: `src/sidepanel/components/Chat.tsx`（在 panel-request 分发处加 `run-local-agent` case）
- Test: `src/sidepanel/components/RunLocalAgentCard.test.tsx`

**Interfaces:**
- Consumes: `usePanelRequest` 的 `active`（`{ requestId, kind, payload }`）+ `respond`
- Produces: `<RunLocalAgentCard payload={{prompt,cwd}} onDecision={(ok:boolean)=>void} />`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sidepanel/components/RunLocalAgentCard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunLocalAgentCard } from "./RunLocalAgentCard";

describe("RunLocalAgentCard", () => {
  it("展示 prompt 与 cwd 原文", () => {
    render(<RunLocalAgentCard payload={{ prompt: "rm -rf /tmp/x", cwd: "/Users/me/proj" }} onDecision={vi.fn()} />);
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeTruthy();
    expect(screen.getByText(/\/Users\/me\/proj/)).toBeTruthy();
  });

  it("点允许/拒绝回传布尔", () => {
    const onDecision = vi.fn();
    render(<RunLocalAgentCard payload={{ prompt: "x", cwd: "y" }} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: /允许|Allow/ }));
    expect(onDecision).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: /拒绝|Deny/ }));
    expect(onDecision).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/sidepanel/components/RunLocalAgentCard.test.tsx`
Expected: FAIL — cannot resolve `./RunLocalAgentCard`

- [ ] **Step 3: 实现卡片**

```tsx
// src/sidepanel/components/RunLocalAgentCard.tsx
interface Props {
  payload: { prompt: string; cwd: string };
  onDecision: (ok: boolean) => void;
}

// 授权卡：本地代码执行前的知情闸。prompt + cwd 原文展示，不经转述（spec §6.1）。
export function RunLocalAgentCard({ payload, onDecision }: Props) {
  return (
    <div className="rounded-[10px] border border-slate-300 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-2 font-medium">运行本地 Agent（claude -p）？</div>
      <div className="mb-1 text-xs text-slate-500">工作目录</div>
      <code className="mb-2 block break-all rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{payload.cwd}</code>
      <div className="mb-1 text-xs text-slate-500">任务</div>
      <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{payload.prompt}</pre>
      <div className="flex gap-2">
        <button className="rounded-md bg-slate-800 px-3 py-1 text-white dark:bg-slate-200 dark:text-slate-900" onClick={() => onDecision(true)}>允许</button>
        <button className="rounded-md border border-slate-300 px-3 py-1 dark:border-slate-600" onClick={() => onDecision(false)}>拒绝</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/sidepanel/components/RunLocalAgentCard.test.tsx`
Expected: PASS (2 passed)

- [ ] **Step 5: 在 Chat.tsx 接线**

Chat.tsx 里 `usePanelRequest` 的返回被解构为 `panelRequest` / `respondPanel`（见 Chat.tsx:314：`const { active: panelRequest, respond: respondPanel } = usePanelRequest(sessionId);`）。既有卡片分发在 Chat.tsx:1602（`panelRequest?.kind === "cdp-consent"`）、:1607（`"local-file"`）。仿其结构、在同一区块加：
```tsx
{panelRequest?.kind === "run-local-agent" && (
  <RunLocalAgentCard
    payload={panelRequest.payload as { prompt: string; cwd: string }}
    onDecision={(ok) => respondPanel(panelRequest.requestId, { ok: true, data: ok })}
  />
)}
```
并在文件顶部 import `RunLocalAgentCard`。（`respondPanel` 的 body 用 `{ ok: true, data: ok }`——`data` 承载用户布尔裁决，与 `handlePanelResponse` 的 `res: boolean` 对应。）

- [ ] **Step 6: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿 + 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/RunLocalAgentCard.tsx src/sidepanel/components/RunLocalAgentCard.test.tsx src/sidepanel/components/Chat.tsx
git commit -m "feat(bridge): run_local_agent HITL authorization card"
```

---

## Task 10: manifest optional_permissions + SW 初始化桥

**Files:**
- Modify: `manifest.json`
- Modify: `src/background/index.ts`（启动时 `initLocalBridge()`，且仅当已授予 nativeMessaging）
- Test: `src/background/local-bridge-init.test.ts`

**Interfaces:**
- Consumes: `initLocalBridge`（Task 6）
- Produces: SW 启动流程调 `maybeInitLocalBridge()` — 检查 `chrome.permissions.contains({permissions:["nativeMessaging"]})`，有才 init

- [ ] **Step 1: manifest 加 optional_permissions**

在 `manifest.json` 顶层（`permissions` 之后）加：
```json
"optional_permissions": ["nativeMessaging"],
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/background/local-bridge-init.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("maybeInitLocalBridge", () => {
  beforeEach(() => vi.resetModules());

  it("无 nativeMessaging 权限 → 不 init", async () => {
    (globalThis as any).chrome = {
      permissions: { contains: vi.fn(async () => false) },
      runtime: { connectNative: vi.fn() },
    };
    const { maybeInitLocalBridge } = await import("./local-bridge");
    await maybeInitLocalBridge();
    expect((globalThis as any).chrome.runtime.connectNative).not.toHaveBeenCalled();
  });

  it("有权限 → init（connectNative 被调）", async () => {
    const fakePort = { postMessage: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() }, disconnect: vi.fn() };
    (globalThis as any).chrome = {
      permissions: { contains: vi.fn(async () => true) },
      runtime: { connectNative: vi.fn(() => fakePort) },
    };
    const { maybeInitLocalBridge } = await import("./local-bridge");
    await maybeInitLocalBridge();
    expect((globalThis as any).chrome.runtime.connectNative).toHaveBeenCalledWith("ai.wiseria.pie");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/background/local-bridge-init.test.ts`
Expected: FAIL — `maybeInitLocalBridge` 未导出

- [ ] **Step 4: 加 maybeInitLocalBridge**

在 `src/background/local-bridge.ts` 追加：
```typescript
/** SW 启动调用：仅当已授予 nativeMessaging 才连桥（纯 BYOK 用户零感知）。 */
export async function maybeInitLocalBridge(): Promise<void> {
  try {
    const has = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
    if (has) initLocalBridge();
  } catch {
    // permissions API 不可用（测试/老 Chrome）→ 静默跳过
  }
}
```

- [ ] **Step 5: SW 启动接线**

在 `src/background/index.ts` 的启动流程（startup-migrations pipeline 之后，参考既有 `setScheduleRunDep` 一带的初始化区）加：
```typescript
import { maybeInitLocalBridge } from "./local-bridge";
// ...启动序列末尾：
void maybeInitLocalBridge();
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm test src/background/local-bridge-init.test.ts && pnpm typecheck`
Expected: PASS + 0 errors

- [ ] **Step 7: Commit**

```bash
git add manifest.json src/background/local-bridge.ts src/background/local-bridge-init.test.ts src/background/index.ts
git commit -m "feat(bridge): optional nativeMessaging permission + gated SW init"
```

---

## Task 11: `.pkg` 安装器 + native host manifest + launchd

**Files:**
- Create: `daemon/install/ai.wiseria.pie.host.template.json`, `daemon/install/ai.wiseria.pie.plist.template`, `daemon/install/postinstall.sh`, `daemon/install/build-pkg.sh`

**注**：打包/签名步骤本 slice 无法在 CI 完全自动验证（需 Apple Developer 证书 + 真机）。此 task 交付**可运行的脚本 + 模板**，端到端验证在 Task 12 手测。签名/公证 Day1 就位（spec §9）——若证书未就位，先 unsigned 本地装（`spctl` 手动放行）跑通链路，signed 打包作为 Task 12 手测前置。

- [ ] **Step 1: native host manifest 模板**

```json
// daemon/install/ai.wiseria.pie.host.template.json
{
  "name": "ai.wiseria.pie",
  "description": "Pie local daemon bridge host",
  "path": "__PIE_BIN__",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://__EXT_ID__/"]
}
```
说明：`__PIE_BIN__` = 安装后 `pie` 二进制绝对路径（如 `/usr/local/bin/pie`）；host 由 Chrome 以 `pie host` 模式 spawn——**因此 manifest 的 `path` 需指向一个以 `host` 为默认参数的 wrapper，或 `pie` 二进制在无参时默认走 host**。决策：`path` 指向 `/usr/local/bin/pie-host`（一个 `exec pie host "$@"` 的 1 行 wrapper 脚本，postinstall 生成），避免改 `cli.ts` 的默认分支语义。`__EXT_ID__` = 扩展 ID（从 chrome://extensions 读，或由 manifest `key` 计算）。

- [ ] **Step 2: launchd plist 模板**

```xml
<!-- daemon/install/ai.wiseria.pie.plist.template -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.wiseria.pie</string>
  <key>ProgramArguments</key>
  <array><string>__PIE_BIN__</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>__LOG__</string>
</dict>
</plist>
```

- [ ] **Step 3: postinstall 脚本**

```bash
#!/bin/bash
# daemon/install/postinstall.sh — .pkg 装完后由 Installer 以用户上下文运行
set -euo pipefail

PIE_BIN="/usr/local/bin/pie"
HOST_WRAPPER="/usr/local/bin/pie-host"
PIE_DIR="$HOME/.pie"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
LA_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$PIE_DIR/logs" "$NM_DIR" "$LA_DIR"

# host wrapper（Chrome spawn 它 → 转 `pie host`）
printf '#!/bin/bash\nexec %s host "$@"\n' "$PIE_BIN" > "$HOST_WRAPPER"
chmod +x "$HOST_WRAPPER"

# 扩展 ID 由打包时注入（build-pkg.sh 替 __EXT_ID__）；此处 host manifest 已就绪于模板拷贝
sed -e "s|__PIE_BIN__|$HOST_WRAPPER|g" \
    "$(dirname "$0")/ai.wiseria.pie.host.template.json" > "$NM_DIR/ai.wiseria.pie.json"

# launchd
sed -e "s|__PIE_BIN__|$PIE_BIN|g" -e "s|__LOG__|$PIE_DIR/logs/daemon.err.log|g" \
    "$(dirname "$0")/ai.wiseria.pie.plist.template" > "$LA_DIR/ai.wiseria.pie.plist"
launchctl unload "$LA_DIR/ai.wiseria.pie.plist" 2>/dev/null || true
launchctl load "$LA_DIR/ai.wiseria.pie.plist"

echo "[pie] installed. run 'pie doctor' to verify."
```

- [ ] **Step 4: build-pkg 脚本**

```bash
#!/bin/bash
# daemon/install/build-pkg.sh — 编译二进制 + 组 .pkg。用法: build-pkg.sh <EXT_ID> [VERSION]
set -euo pipefail
EXT_ID="${1:?need extension id}"
VERSION="${2:-0.0.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1) 编译单二进制
( cd "$ROOT" && bun build ./src/cli.ts --compile --outfile dist/pie )

# 2) payload 目录
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/usr/local/bin"
cp "$ROOT/dist/pie" "$STAGE/usr/local/bin/pie"
chmod +x "$STAGE/usr/local/bin/pie"

# 3) 注入 EXT_ID 到 host template（postinstall 用到的那份随 scripts 走）
SCRIPTS="$(mktemp -d)"
cp "$ROOT/install/postinstall.sh" "$SCRIPTS/postinstall"
chmod +x "$SCRIPTS/postinstall"
sed "s|__EXT_ID__|$EXT_ID|g" "$ROOT/install/ai.wiseria.pie.host.template.json" > "$SCRIPTS/ai.wiseria.pie.host.template.json"
cp "$ROOT/install/ai.wiseria.pie.plist.template" "$SCRIPTS/"

# 4) 组 pkg（签名/公证：证书就位后加 --sign "Developer ID Installer: ..." + notarytool）
pkgbuild --root "$STAGE" --scripts "$SCRIPTS" \
  --identifier ai.wiseria.pie --version "$VERSION" \
  "$ROOT/dist/pie-$VERSION.pkg"
echo "built dist/pie-$VERSION.pkg (unsigned — sign+notarize before distribution)"
```

- [ ] **Step 5: Commit**

```bash
chmod +x daemon/install/postinstall.sh daemon/install/build-pkg.sh
git add daemon/install/
git commit -m "feat(daemon): macOS .pkg installer + native host manifest + launchd plist"
```

---

## Task 12: 端到端手测 + CI + 文档

**Files:**
- Modify: `.github/workflows/ci.yml`（若存在，加 daemon bun job）
- Create: `docs/release-notes/`（可选）或在 spec 勾掉 Slice 0

- [ ] **Step 1: CI 加 daemon job**

先 `ls .github/workflows/`。若有 CI，加一段：
```yaml
  daemon:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: cd daemon && bun install && bun test
```
（若无 CI 文件，跳过，记在 commit message。）

- [ ] **Step 2: 编译 + 装**

```bash
cd daemon
bun build ./src/cli.ts --compile --outfile dist/pie
# 取扩展 ID：chrome://extensions 打开 Pie，复制 ID
bash install/build-pkg.sh <EXT_ID> 0.0.1
sudo installer -pkg dist/pie-0.0.1.pkg -target /   # 或双击
pie doctor    # 期望：socket present + claude CLI found
```

- [ ] **Step 3: 扩展侧开启本地打通**

1）`pnpm build`，chrome://extensions 刷新
2）Pie 设置页触发 nativeMessaging 权限请求（Slice 0 可临时在设置页加一个「启用本地打通」按钮调 `chrome.permissions.request({permissions:["nativeMessaging"]})` 后 `maybeInitLocalBridge()`；正式 UI 归 Slice 5）
3）重启 Chrome（读新 host manifest）

- [ ] **Step 4: 端到端跑通**

在 Pie 对话里让 agent 执行需要本地 Agent 的任务（如「用本地 claude 在临时目录写个 hello.txt 并告诉我内容」）：
- 期望：弹 `RunLocalAgentCard`（prompt + cwd 原文）
- 点允许 → daemon spawn `claude -p` → 结果作 observation 回 loop → agent 复述结果
- `~/.pie/logs/daemon.err.log` 有 listening 日志

- [ ] **Step 5: 验证降级不硬挂**

- `launchctl unload ~/Library/LaunchAgents/ai.wiseria.pie.plist` 停 daemon
- 重启 Chrome → Pie 正常，`run_local_agent` **不出现在工具里**，其余功能完好

- [ ] **Step 6: 勾掉 Slice 0 + 提交**

在 spec §3 的 Slice 0 打勾，更新 ROADMAP。
```bash
git add docs/ .github/
git commit -m "chore(bridge): Slice 0 end-to-end verified + CI daemon job"
```

---

## Self-Review

**1. Spec coverage（Slice 0 范围内）：**
- 单二进制 `pie`（daemon/host/doctor）✓ Task 2–5 | native host 透传 ✓ Task 5 | daemon 空壳→socket+hello ✓ Task 3 | `local-bridge.ts` ✓ Task 6 | `hello` + protocolVersion ✓ Task 1/3/6 | round-trip 全链路 ✓ Task 4/7/8/9 | `.pkg` 安装器 ✓ Task 11 | `pie doctor` ✓ Task 2 | HITL 授权卡（prompt+cwd 原文、每次弹、不持久）✓ Task 9 | 条件装配降级不硬挂 ✓ Task 8 | optional nativeMessaging ✓ Task 10 | untrusted wrapper ✓ Task 7 | 构建期不变量登记 ✓ Task 7 | 版本兼容窗口 ✓ Task 6。
- **Slice 0 外（已在 plan 顶部 defer 标注，非 gap）**：live 流式渲染、hand-off、skill 执行器、MCP、反向、grant 持久化、自更新、codex、stream-json、重连退避。

**2. Placeholder scan：** 无 TBD/TODO；Task 11 打包签名的「证书就位后」是真实外部前置，非代码占位；Task 8 Step 5 与 Task 12 Step 3 的「临时按钮/正式 UI 归 Slice 5」是显式范围切分，非含糊。

**3. Type consistency：** `RunLocalAgentParams{target,prompt,cwd?}` / `RunLocalAgentResult{output,exitCode,cwd}` 在 Task 1 定义，Task 4（daemon）/6（bridge）/7（tool）一致引用；`requestLocalAgent` 签名 Task 6 定义、Task 8 消费一致；`buildRunLocalAgentTool` deps `{run,requestConsent}` Task 7 定义、Task 8 注入一致；panel kind `"run-local-agent"` payload `{prompt,cwd}` Task 8 定义、Task 9 消费一致；host name `"ai.wiseria.pie"` 全程一致。

## Execution Handoff

两种执行方式，见下条消息。
