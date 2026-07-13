# 适配更多本地 Agent（#269）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** handoff 候选表从 3 条扩到 8 条（Claude / Codex / Cursor / OpenCode / Pi），并修掉 daemon 在 launchd 裸 PATH 下检测不到任何 CLI 的地基 bug。

**Architecture:** 三处表结构改动全是数据化（`argv` 模板 / `appPaths` 优先级列表 / `convention` 引导文件名），daemon 里零 if 分支。地基修复 = `detectAgents()` 问用户 login shell 要 PATH → `Bun.which` 拿**绝对路径** → `start.command` 里 exec 绝对路径。wire 协议、扩展侧 UI 逻辑、plist、安装脚本零改动。

**Tech Stack:** Bun（daemon，`bun test`）、TypeScript、React 19 + vitest（扩展侧图标）。

**Spec:** `docs/specs/2026-07-14-more-local-agents.md`（含七条真机验证证据与三个图标 SVG 成品）。

## Global Constraints

- **绝不凭空编 spawn 命令**：`agents.ts` 的候选表是唯一 launch 权威，wire 上只传 id。本 plan 里的每条命令都已在 2026-07-14 真机验证过（见 spec §5），不得改动其形态。
- **wire 不动**：`src/types/local-bridge.ts` 零改动，`PROTOCOL_VERSION` 保持 1。
- **daemon 测试 hermetic**：`setLogEnabled(false)`，一切 IO（spawn / writeFile / ensureDir / which / exists）走注入，禁止在测试里碰真实文件系统或真实 shell。
- **prompt 常量不变**：terminal 与 app 引导文件里的那句话都是 `Read context.md in this directory for the handed-off context, then continue the task.`
- **表顺序 = HandoffCard 预选顺序**：品牌分组，每组 app 在前。
- 提交前跑 `pnpm test`、`pnpm typecheck`、`pnpm build`（根目录）与 `cd daemon && bun test`。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `daemon/src/agents.ts` | 候选表（唯一 launch 权威）+ 检测 | 类型三改、PATH 探测、detect 返回绝对路径、表扩 8 条 |
| `daemon/src/handoff.ts` | 交棒目录 + start.command + spawn | exec 绝对路径（含 shell quote）、argv 模板、convention 文件、RESERVED |
| `daemon/test/agents.test.ts` | 表 + 检测的测试 | 重写 |
| `daemon/test/handoff.test.ts` | 交棒的测试 | 扩充 |
| `src/sidepanel/components/hitl/agent-brand-icons.tsx` | 品牌图标（inline SVG，CSP 禁外链） | 前缀查表化 + Cursor/OpenCode/Pi 三个 mark |
| `src/sidepanel/components/hitl/agent-brand-icons.test.tsx` | 图标测试 | 新建 |

`daemon/src/daemon.ts`（`list_agents`）**不需要改**：它 map 的是 `AGENT_CANDIDATES`（表扩容自动生效）+ `detectAgents()` 的 id 集合，两者的接口都不变。

---

### Task 1: login shell PATH 探测

**Files:**
- Modify: `daemon/src/agents.ts`
- Test: `daemon/test/agents.test.ts`

**Interfaces:**
- Produces: `parseShellPath(stdout: string, fallback: string): string` — 纯函数，从 shell 输出里取 PATH。`getUserPath(): string` — 探测 + 兜底，供 Task 2 的 `detectAgents` 使用。

**背景（实现者必读）：** daemon 由 launchd 启动（`~/Library/LaunchAgents/ai.wiseria.pie.plist`，`RunAtLoad`/`KeepAlive`），中间没有 shell，所以 `.zshrc` / `path_helper` 一行都不会被读。实测运行中的 daemon 进程 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`，`Bun.which("claude")` 返回 null——**所有** agent CLI 都检测不到。修法是问用户自己的 login shell 要 PATH。

- [ ] **Step 1: 写失败测试**

在 `daemon/test/agents.test.ts` 顶部追加（保留文件里已有的测试，Task 2 才重写它们）：

```ts
import { parseShellPath } from "../src/agents";

test("parseShellPath: takes the last line (rc 噪音在前面)", () => {
  const stdout = "Last login: whatever\n/usr/bin:/opt/homebrew/bin\n";
  expect(parseShellPath(stdout, "/fallback")).toBe("/usr/bin:/opt/homebrew/bin");
});

test("parseShellPath: 空输出（shell 挂了/超时）回落 fallback", () => {
  expect(parseShellPath("", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  expect(parseShellPath("   \n  \n", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
});

test("parseShellPath: 单行正常输出", () => {
  expect(parseShellPath("/a:/b\n", "/fallback")).toBe("/a:/b");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/agents.test.ts`
Expected: FAIL — `parseShellPath` 不存在（`SyntaxError: Export named 'parseShellPath' not found`）

- [ ] **Step 3: 实现**

在 `daemon/src/agents.ts` 里，`AgentCandidate` 接口之前插入：

```ts
/**
 * shell 输出里取 PATH：只认最后一个非空行。rc 里的 banner / 提示会先打出来，
 * 真正的 `echo $PATH` 永远在最后。空输出（shell 挂了 / 超时）回落 fallback。
 */
export function parseShellPath(stdout: string, fallback: string): string {
  const last = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  return last || fallback;
}

/**
 * daemon 跑在 launchd 下，PATH 是裸的 /usr/bin:/bin:/usr/sbin:/sbin ——
 * 看不见 ~/.local/bin、/opt/homebrew/bin、~/.opencode/bin 里的任何 agent CLI
 * （"Dock 启动的 app 找不到 node/brew" 同款坑）。问用户自己的 login shell 要真相。
 *
 * 不缓存：实测 0.10–0.16s，而 detect 只在「弹授权卡」「打开设置页」两个点被调用，
 * 无感。不缓存换来的是：用户装完新 agent 立刻可见，不需要重启 daemon，也不需要
 * 教用户什么叫「刷新」。
 *
 * stdin: "ignore" —— 防 zsh 启动期读 stdin 的东西（oh-my-zsh 升级提示的 read -k）
 * 把探测挂死；与 handoff.ts 的 LAUNCH_PAD 是同一个坑的两面。
 * timeout 3000 —— rc 重度定制的用户可能要一两秒；超时宁可检测不到，也不能卡住授权卡。
 */
export function getUserPath(): string {
  const fallback = process.env.PATH ?? "";
  try {
    const r = Bun.spawnSync([process.env.SHELL ?? "/bin/zsh", "-lic", "echo $PATH"], {
      stdin: "ignore",
      timeout: 3000,
    });
    return parseShellPath(r.stdout.toString(), fallback);
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test test/agents.test.ts`
Expected: PASS（新增 3 个 + 原有 3 个全绿）

- [ ] **Step 5: 提交**

```bash
git add daemon/src/agents.ts daemon/test/agents.test.ts
git commit -m "feat(daemon): 探 login shell 的 PATH（launchd 裸 PATH 看不见任何 agent CLI）"
```

---

### Task 2: detect 返回绝对路径

**Files:**
- Modify: `daemon/src/agents.ts`
- Modify: `daemon/src/handoff.ts`
- Test: `daemon/test/agents.test.ts`（重写检测相关用例）
- Test: `daemon/test/handoff.test.ts`

**Interfaces:**
- Consumes: `getUserPath()`（Task 1）
- Produces: `DetectedAgent = AgentCandidate & { path: string }`；`detectAgents(opts?: DetectOpts): DetectedAgent[]`。`path` 是 terminal 的 bin 绝对路径 / app 的命中 bundle 路径 —— **spawn 只许用 `path`，不许再用 `bin` / `appPath`**。

**背景：** 光有 PATH 还不够。`start.command` 里 `exec opencode`（裸命令名）依赖那个 bash 的运行时 PATH，真机实测报 `exec: opencode: not found`——同一个根因的第二个症状。detect 时就把绝对路径解出来，spawn 时直接用，两个症状一起消失。

- [ ] **Step 1: 写失败测试**

`daemon/test/agents.test.ts` — 把原有的 `detectAgents filters by injected which/exists...` 与 `returns empty...` 两个用例替换为：

```ts
import { AGENT_CANDIDATES, detectAgents, parseShellPath } from "../src/agents";

test("detectAgents 带出绝对路径（terminal = which 解出的，app = 命中的 bundle 路径）", () => {
  const detected = detectAgents({
    which: (bin) => (bin === "codex" ? "/Users/x/.local/bin/codex" : null),
    exists: (p) => p === "/Applications/Claude.app",
  });
  expect(detected.map((a) => a.id)).toEqual(["claude-app", "codex-terminal"]);
  expect(detected.find((a) => a.id === "codex-terminal")!.path).toBe("/Users/x/.local/bin/codex");
  expect(detected.find((a) => a.id === "claude-app")!.path).toBe("/Applications/Claude.app");
});

test("detectAgents returns empty when nothing installed", () => {
  expect(detectAgents({ which: () => null, exists: () => false })).toEqual([]);
});
```

`daemon/test/handoff.test.ts` — 把 harness 的 `detect` 改为带 path，并新增一条绝对路径断言。harness 里：

```ts
    detect: () => AGENT_CANDIDATES.map((c) => ({
      ...c,
      path: c.kind === "app" ? c.appPath! : `/Users/x/.local/bin/${c.bin}`,
    })),
```

并把原用例里的 `expect(cmd?.content).toContain("exec claude")` 改成：

```ts
  expect(cmd?.content).toContain("exec '/Users/x/.local/bin/claude'");
  expect(cmd?.content).not.toContain("exec claude ");  // 裸命令名 = 依赖运行时 PATH = 真机上会 not found
```

新增一条（路径含空格的用户不能炸）：

```ts
test("start.command 里绝对路径带空格也安全（shell quote）", async () => {
  const h = harness();
  h.opts.detect = () => [{
    id: "claude-terminal" as const, label: "Claude Code (Terminal)", kind: "terminal" as const,
    bin: "claude", path: "/Users/na me/.local/bin/claude",
  }];
  await runHandoff({ target: "claude-terminal", context: "x" }, h.opts);
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain("exec '/Users/na me/.local/bin/claude'");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/agents.test.ts test/handoff.test.ts`
Expected: FAIL —— `detected[0].path` is undefined；`start.command` 里仍是 `exec claude`

- [ ] **Step 3: 实现**

`daemon/src/agents.ts` — 在 `AgentCandidate` 之后加 `DetectedAgent`，并重写 `detectAgents`：

```ts
/** 检测结果 = 候选 + 解析出的绝对路径。spawn 只许用 path（裸命令名依赖运行时 PATH，真机上会 not found）。 */
export type DetectedAgent = AgentCandidate & { path: string };

export interface DetectOpts {
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
}

/** 每次调用现检测（which/exists 都便宜，PATH 探测 0.1s 级，无缓存必要）；保持表顺序。 */
export function detectAgents(opts?: DetectOpts): DetectedAgent[] {
  const userPath = opts?.which ? "" : getUserPath();   // 注入 which 时不必探 shell
  const which = opts?.which ?? ((b: string) => Bun.which(b, { PATH: userPath }));
  const exists = opts?.exists ?? existsSync;
  const out: DetectedAgent[] = [];
  for (const c of AGENT_CANDIDATES) {
    const path = c.kind === "app" ? (exists(c.appPath!) ? c.appPath! : null) : which(c.bin!);
    if (path) out.push({ ...c, path });
  }
  return out;
}
```

`daemon/src/handoff.ts` — 新增 shell quote 工具（放在 `slugify` 旁边）：

```ts
/**
 * 单引号包裹 + 转义内部单引号。路径来自 which / 文件系统，可能含空格
 * （/Users/na me/.local/bin/claude）——裸拼进 exec 会被拆成两个参数。
 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

把 app 分支的 spawn 从 `open -a agent.appName!` 改为命中的路径：

```ts
    const r = await spawn("open", ["-a", agent.path, dir], dir);
```

把 terminal 分支的 script 生成改为绝对路径：

```ts
  const script =
    `#!/bin/bash\n` +
    `cd ${JSON.stringify(dir)} || exit 1\n` +
    `exec ${shq(agent.path)} "Read context.md in this directory for the handed-off context, then continue the task."\n`;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test`
Expected: PASS（全量绿）

- [ ] **Step 5: 提交**

```bash
git add daemon/src/agents.ts daemon/src/handoff.ts daemon/test/agents.test.ts daemon/test/handoff.test.ts
git commit -m "fix(daemon): detect 解出绝对路径，start.command exec 绝对路径（修 opencode not found）"
```

---

### Task 3: appPaths — Codex/ChatGPT 合并后的多路径检测

**Files:**
- Modify: `daemon/src/agents.ts`
- Test: `daemon/test/agents.test.ts`

**Interfaces:**
- Consumes: `DetectedAgent`（Task 2）
- Produces: `AgentCandidate.appPaths: string[]`（取代 `appPath` + `appName` 两个字段）

**背景：** Codex app 与 ChatGPT app 已合并为同一个 bundle（`com.openai.codex`——本机 `/Applications/ChatGPT.app` 的 bundle id 实测就是它，没有独立的 `Codex.app`）。检测得按优先级探多条路径。顺带把 `appName` 干掉：`open -a` 接受完整路径，用命中的绝对路径比用 app 名更稳（app 再改名也不影响）。

- [ ] **Step 1: 写失败测试**

`daemon/test/agents.test.ts`：

```ts
test("app 候选按 appPaths 优先级探，命中第一个存在的", () => {
  // 只装了 ChatGPT.app（Codex 与 ChatGPT 合并后的常态）
  const detected = detectAgents({
    which: () => null,
    exists: (p) => p === "/Applications/ChatGPT.app",
  });
  const codexApp = detected.find((a) => a.id === "codex-app");
  expect(codexApp?.path).toBe("/Applications/ChatGPT.app");
});

test("两个 app 路径都在时，取表里排第一的", () => {
  const detected = detectAgents({
    which: () => null,
    exists: (p) => p === "/Applications/Codex.app" || p === "/Applications/ChatGPT.app",
  });
  expect(detected.find((a) => a.id === "codex-app")?.path).toBe("/Applications/Codex.app");
});

test("候选表字段齐备：terminal 有 bin，app 有 appPaths", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "terminal") expect(c.bin).toBeDefined();
    else expect(c.appPaths?.length).toBeGreaterThan(0);
  }
});
```

（本任务的测试引用 `codex-app`，它在 Task 6 才进表——所以本任务同时把 `codex-app` 这一行加进表。表其余 4 条新候选留给 Task 6。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/agents.test.ts`
Expected: FAIL —— 找不到 `codex-app`；`appPaths` 不存在

- [ ] **Step 3: 实现**

`daemon/src/agents.ts` — 改接口 + 改表 + 改 detect 的 app 分支：

```ts
export interface AgentCandidate {
  id: "claude-app" | "claude-terminal" | "codex-app" | "codex-terminal";
  label: string;
  kind: "app" | "terminal";
  /** terminal：检测用的 bin 名（spawn 用 DetectedAgent.path，不是这个） */
  bin?: string;
  /** app：按优先级探，命中第一个存在的；spawn 用命中的绝对路径。 */
  appPaths?: string[];
}

export const AGENT_CANDIDATES: readonly AgentCandidate[] = [
  { id: "claude-app", label: "Claude Code (App)", kind: "app", appPaths: ["/Applications/Claude.app"] },
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude" },
  // Codex 与 ChatGPT app 已合并为同一 bundle（com.openai.codex）。优先 Codex.app
  // （万一 OpenAI 再拆回来），回落 ChatGPT.app。显示名合并成 "Codex / ChatGPT"。
  { id: "codex-app", label: "Codex / ChatGPT (App)", kind: "app",
    appPaths: ["/Applications/Codex.app", "/Applications/ChatGPT.app"] },
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex" },
];
```

`detectAgents` 的 app 分支改成找第一个存在的路径：

```ts
    const path =
      c.kind === "app"
        ? (c.appPaths!.find((p) => exists(p)) ?? null)
        : which(c.bin!);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test`
Expected: PASS（`handoff.test.ts` 的 harness 里 `c.appPath!` 需同步改成 `c.appPaths![0]`）

- [ ] **Step 5: 提交**

```bash
git add daemon/src/agents.ts daemon/src/handoff.ts daemon/test/
git commit -m "feat(daemon): appPaths 多路径检测 + codex-app（Codex/ChatGPT 已合并同一 bundle）"
```

---

### Task 4: argv 模板 — 位置参数 vs flag 的差异数据化

**Files:**
- Modify: `daemon/src/agents.ts`
- Modify: `daemon/src/handoff.ts`
- Test: `daemon/test/handoff.test.ts`

**Interfaces:**
- Produces: `AgentCandidate.argv: string[]`（含 `"{prompt}"` 占位符）

**背景：** `claude` / `codex` / `cursor-agent` / `pi` 收位置参数（`bin "<prompt>"`），`opencode` 收 flag（`opencode --prompt "<prompt>"`）。真机验证过 `opencode --prompt` 是**自动发送**的（不是只预填输入框），所以它跟其余四家一样属于"自动开跑"，`mode: "terminal"` 语义不变。把差异表达成数据，daemon 里零 if 分支。

- [ ] **Step 1: 写失败测试**

`daemon/test/handoff.test.ts`：

```ts
test("argv 模板：位置参数形态（claude）", async () => {
  const h = harness();
  await runHandoff({ target: "claude-terminal", context: "x" }, h.opts);
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain(
    `exec '/Users/x/.local/bin/claude' 'Read context.md in this directory for the handed-off context, then continue the task.'`,
  );
});

test("argv 模板：flag 形态（opencode --prompt）", async () => {
  const h = harness();
  h.opts.detect = () => [{
    id: "opencode-terminal" as const, label: "OpenCode (Terminal)", kind: "terminal" as const,
    bin: "opencode", argv: ["--prompt", "{prompt}"], path: "/Users/x/.opencode/bin/opencode",
  }];
  await runHandoff({ target: "opencode-terminal", context: "x" }, h.opts);
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain(
    `exec '/Users/x/.opencode/bin/opencode' '--prompt' 'Read context.md in this directory for the handed-off context, then continue the task.'`,
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/handoff.test.ts`
Expected: FAIL —— `--prompt` 没出现在 start.command 里（现在的实现写死了位置参数）

- [ ] **Step 3: 实现**

`daemon/src/agents.ts` — `AgentCandidate` 加字段，四条 terminal 候选各加 `argv`：

```ts
  /** terminal：argv 模板，"{prompt}" 占位。位置参数 vs flag 的差异只是数据。 */
  argv?: string[];
```

```ts
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude", argv: ["{prompt}"] },
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex", argv: ["{prompt}"] },
```

`daemon/src/handoff.ts` — 把交棒 prompt 提成常量（app 引导文件 Task 5 会复用它），script 生成走模板：

```ts
/** 交棒引导语：terminal 直接注入 argv，app 写进 convention 文件。 */
const HANDOFF_PROMPT =
  "Read context.md in this directory for the handed-off context, then continue the task.";
```

```ts
  const args = (agent.argv ?? ["{prompt}"]).map((a) => a.replace("{prompt}", HANDOFF_PROMPT));
  const script =
    `#!/bin/bash\n` +
    `cd ${JSON.stringify(dir)} || exit 1\n` +
    `exec ${shq(agent.path)} ${args.map(shq).join(" ")}\n`;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add daemon/src/agents.ts daemon/src/handoff.ts daemon/test/handoff.test.ts
git commit -m "feat(daemon): argv 模板（opencode 走 --prompt，其余位置参数）"
```

---

### Task 5: convention — app 模式的引导文件按 agent 走

**Files:**
- Modify: `daemon/src/agents.ts`
- Modify: `daemon/src/handoff.ts`
- Test: `daemon/test/handoff.test.ts`

**Interfaces:**
- Produces: `AgentCandidate.convention: "CLAUDE.md" | "AGENTS.md"`

**背景：** app 模式没有 prompt 注入面（`open -a <app> <dir>` 只能把目录当工作区打开），靠目录内的约定文件引导。Claude 系读 `CLAUDE.md`，Codex / Cursor 读 `AGENTS.md`（AGENTS.md 是 2026 的开放标准，Codex / Cursor / Copilot / Gemini / Aider / Zed 原生读）。配套：`RESERVED` 加 `agents.md`，否则 LLM stage 的文件可能撞名覆盖引导文件。

- [ ] **Step 1: 写失败测试**

`daemon/test/handoff.test.ts`：

```ts
test("app 模式按 convention 写引导文件：Claude → CLAUDE.md", async () => {
  const h = harness();
  const r = await runHandoff({ target: "claude-app", context: "x" }, h.opts);
  expect(r.mode).toBe("app");
  const guide = h.writes.find((w) => w.path.endsWith("CLAUDE.md"));
  expect(guide?.content).toContain("Read context.md");
  expect(h.writes.find((w) => w.path.endsWith("AGENTS.md"))).toBeUndefined();
  expect(h.spawns[0]).toMatchObject({ cmd: "open", args: ["-a", "/Applications/Claude.app", r.dir] });
});

test("app 模式按 convention 写引导文件：Codex → AGENTS.md", async () => {
  const h = harness();
  const r = await runHandoff({ target: "codex-app", context: "x" }, h.opts);
  const guide = h.writes.find((w) => w.path.endsWith("AGENTS.md"));
  expect(guide?.content).toContain("Read context.md");
  expect(h.writes.find((w) => w.path.endsWith("CLAUDE.md"))).toBeUndefined();
});

test("RESERVED 挡掉 agents.md（大小写不敏感）", () => {
  expect(() => safeFileName("AGENTS.md")).toThrow();
  expect(() => safeFileName("agents.md")).toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/handoff.test.ts`
Expected: FAIL —— codex-app 写的还是 CLAUDE.md；`safeFileName("AGENTS.md")` 不抛

- [ ] **Step 3: 实现**

`daemon/src/agents.ts` — 加字段并给两条 app 候选填上：

```ts
  /** app：目录内的约定引导文件名（app 无 prompt 注入面，靠它引导）。 */
  convention?: "CLAUDE.md" | "AGENTS.md";
```

```ts
  { id: "claude-app", label: "Claude Code (App)", kind: "app",
    appPaths: ["/Applications/Claude.app"], convention: "CLAUDE.md" },
  { id: "codex-app", label: "Codex / ChatGPT (App)", kind: "app",
    appPaths: ["/Applications/Codex.app", "/Applications/ChatGPT.app"], convention: "AGENTS.md" },
```

`daemon/src/handoff.ts` — `RESERVED` 加 `agents.md`，删掉写死的 `CLAUDE_MD_CONVENTION`，app 分支按 convention 写：

```ts
const RESERVED = new Set(["context.md", "start.command", "claude.md", "agents.md"]);
```

```ts
  if (agent.kind === "app") {
    // app 直开：`open -a <bundle 路径> <dir>` → 会话根在该目录。无 prompt 注入面
    // → 目录内的约定文件引导（Claude 系读 CLAUDE.md，Codex/Cursor 读 AGENTS.md）。
    // 人到场发一句即开跑（mode 回传给扩展，observation 明示需发一句）。
    writeFile(join(dir, agent.convention ?? "AGENTS.md"), `${HANDOFF_PROMPT}\n`);
    log("info", "handoff.open_app", { dir, target: agent.id, files: (params.files ?? []).length });
    const r = await spawn("open", ["-a", agent.path, dir], dir);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add daemon/src/agents.ts daemon/src/handoff.ts daemon/test/handoff.test.ts
git commit -m "feat(daemon): convention 引导文件（Claude→CLAUDE.md / Codex·Cursor→AGENTS.md）"
```

---

### Task 6: 候选表扩到 8 条

**Files:**
- Modify: `daemon/src/agents.ts`
- Test: `daemon/test/agents.test.ts`

**Interfaces:**
- Produces: 完整的 8 条候选表（id 联合类型扩全）

**背景：** 地基（Task 1–5）齐了，这一步纯粹是数据行。每条命令都在 2026-07-14 真机验证过（spec §5），不得改动形态。**Hermes 与 Openclaw 明确不进表**（Hermes 没有"交互式 + 自动带初始 prompt"的形态；Openclaw 是 gateway 架构，与 exec 范式不同构）。

- [ ] **Step 1: 写失败测试**

`daemon/test/agents.test.ts` — 替换掉那条 "exactly three first-batch agents" 的用例：

```ts
test("候选表 8 条，品牌分组、每组 app 在前（= HandoffCard 预选顺序）", () => {
  expect(AGENT_CANDIDATES.map((c) => c.id)).toEqual([
    "claude-app", "claude-terminal",
    "codex-app", "codex-terminal",
    "cursor-app", "cursor-terminal",
    "opencode-terminal", "pi-terminal",
  ]);
});

test("terminal 候选的 argv 必须含 {prompt} 占位（否则交棒开不了跑）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind !== "terminal") continue;
    expect(c.argv?.some((a) => a.includes("{prompt}"))).toBe(true);
  }
});

test("app 候选必须有 convention（无 prompt 注入面，只能靠引导文件）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "app") expect(c.convention).toBeDefined();
  }
});

test("opencode 走 --prompt flag，其余 terminal 走位置参数", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(byId["opencode-terminal"].argv).toEqual(["--prompt", "{prompt}"]);
  expect(byId["claude-terminal"].argv).toEqual(["{prompt}"]);
  expect(byId["cursor-terminal"].argv).toEqual(["{prompt}"]);
  expect(byId["pi-terminal"].argv).toEqual(["{prompt}"]);
  expect(byId["cursor-terminal"].bin).toBe("cursor-agent");  // 注意：不是 "cursor"（那是 IDE 启动器）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/agents.test.ts`
Expected: FAIL —— 表里只有 4 条

- [ ] **Step 3: 实现**

`daemon/src/agents.ts` — id 联合类型扩全，表补 4 条：

```ts
export interface AgentCandidate {
  id:
    | "claude-app" | "claude-terminal"
    | "codex-app" | "codex-terminal"
    | "cursor-app" | "cursor-terminal"
    | "opencode-terminal" | "pi-terminal";
  // …其余字段不变
}

export const AGENT_CANDIDATES: readonly AgentCandidate[] = [
  { id: "claude-app", label: "Claude Code (App)", kind: "app",
    appPaths: ["/Applications/Claude.app"], convention: "CLAUDE.md" },
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude", argv: ["{prompt}"] },

  // Codex 与 ChatGPT app 已合并为同一 bundle（com.openai.codex）。
  { id: "codex-app", label: "Codex / ChatGPT (App)", kind: "app",
    appPaths: ["/Applications/Codex.app", "/Applications/ChatGPT.app"], convention: "AGENTS.md" },
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex", argv: ["{prompt}"] },

  // Cursor 是 IDE：app 形态打开的是一个只有 context.md + AGENTS.md 的工作区，
  // 用户 ⌘L 发一句话让 agent 接手（已知取舍，见 spec §6）。
  // CLI 是 cursor-agent —— /Applications/Cursor.app 里的 `cursor` 是 IDE 启动器，不是 agent。
  { id: "cursor-app", label: "Cursor (App)", kind: "app",
    appPaths: ["/Applications/Cursor.app"], convention: "AGENTS.md" },
  { id: "cursor-terminal", label: "Cursor (Terminal)", kind: "terminal", bin: "cursor-agent", argv: ["{prompt}"] },

  // opencode 的交互式 TUI 用 --prompt 带初始 prompt（真机验证：自动发送，不是预填输入框）。
  { id: "opencode-terminal", label: "OpenCode (Terminal)", kind: "terminal", bin: "opencode",
    argv: ["--prompt", "{prompt}"] },

  // pi（badlogic/pi-mono coding agent）：位置参数，`pi "<prompt>"`。
  { id: "pi-terminal", label: "Pi (Terminal)", kind: "terminal", bin: "pi", argv: ["{prompt}"] },
];
```

同时更新文件顶部的表注释（现在写着"三条"）：

```ts
/**
 * 静态候选表 = 唯一 launch 权威：spawn 的命令 / app 路径只住在这里，绝不来自 wire 或
 * LLM 参数（wire 上只传 id，daemon 用 id 查表）。加新 agent = 加一行，**但必须先在真机上
 * 验证过那条命令**——绝不凭空编 spawn 命令。
 *
 * 顺序即 HandoffCard 的预选顺序：品牌分组，每组 app 在前（app 无 shell、无 TCC，launch 最稳）。
 *
 * 不在表里的：Hermes（没有"交互式 + 自动带初始 prompt"的形态，-z 是 headless 打印即退，
 * hermes chat 无法注入初始 prompt）、Openclaw（gateway 架构，与 exec start.command 范式不同构）。
 */
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test && cd .. && pnpm typecheck`
Expected: PASS + typecheck 0 错

- [ ] **Step 5: 提交**

```bash
git add daemon/src/agents.ts daemon/test/agents.test.ts
git commit -m "feat(daemon): 候选表扩至 8 条（+ Cursor / OpenCode / Pi，全部真机验证过）"
```

---

### Task 7: 品牌图标（Cursor / OpenCode / Pi）

**Files:**
- Modify: `src/sidepanel/components/hitl/agent-brand-icons.tsx`
- Test: `src/sidepanel/components/hitl/agent-brand-icons.test.tsx`（新建）

**Interfaces:**
- Consumes: `AgentBrandIcon({ agentId, size })` 的现有签名不变（`HandoffCard.tsx:72` 在用）
- Produces: 同一个组件，新增三家 mark

**背景：** MV3 CSP 禁外链，图标必须是 inline SVG。现有实现是一串 `if (agentId.startsWith(...))`；id 涨到 8 个之后换成显式查表，避免 `startsWith("pi")` 这类短前缀将来误伤新 id。颜色规则：Claude 用品牌橙硬编码（不随主题翻转），其余一律 `currentColor`（原稿是纯黑或纯白的，直接用会在某个主题下隐形）。

- [ ] **Step 1: 写失败测试**

新建 `src/sidepanel/components/hitl/agent-brand-icons.test.tsx`：

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AgentBrandIcon } from "./agent-brand-icons";

describe("AgentBrandIcon", () => {
  it("按 id 前缀选对品牌（app / terminal 两形态共用一个 mark）", () => {
    const brandOf = (agentId: string) =>
      render(<AgentBrandIcon agentId={agentId} />).container.querySelector("svg")?.dataset.brand;
    expect(brandOf("claude-app")).toBe("claude");
    expect(brandOf("claude-terminal")).toBe("claude");
    expect(brandOf("codex-app")).toBe("codex");
    expect(brandOf("cursor-app")).toBe("cursor");
    expect(brandOf("cursor-terminal")).toBe("cursor");
    expect(brandOf("opencode-terminal")).toBe("opencode");
    expect(brandOf("pi-terminal")).toBe("pi");
  });

  it("未知 id 回退 generic（不崩）", () => {
    const { container } = render(<AgentBrandIcon agentId="whatever-new-agent" />);
    expect(container.querySelector("svg")?.dataset.brand).toBe("generic");
  });

  it("Pi 的 P 形靠 evenodd 挖洞，丢了就变实心块", () => {
    const { container } = render(<AgentBrandIcon agentId="pi-terminal" />);
    const holed = container.querySelector('path[fill-rule="evenodd"]');
    expect(holed).not.toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/hitl/agent-brand-icons.test.tsx`
Expected: FAIL —— `brandOf("cursor-app")` 得到 `"generic"`（Cursor/OpenCode/Pi 还没有 mark）

- [ ] **Step 3: 实现**

重写 `src/sidepanel/components/hitl/agent-brand-icons.tsx`。保留 `CLAUDE_PATH` / `CODEX_PATH` 两个常量原样（不要动那两串 path），改成前缀查表：

```tsx
/**
 * 本地 Agent 品牌图标（#270 / #269）：inline SVG（MV3 CSP 禁外链），按 daemon
 * AGENT_CANDIDATES 的 id 前缀键控——app / terminal 两个形态共用一个 mark。
 *
 * 颜色：Claude 用 brand 橙（不随主题翻转，故硬编码）；其余官方 mark 的原稿要么纯黑
 * （Codex / OpenCode 外框）要么纯白（Pi），直接用会在某个主题下隐形 → 一律 currentColor。
 * OpenCode 的内块是品牌灰 #CFCECD，浅色/暗色底上都可辨，保留。
 *
 * 前缀查表（不是 if 链）：id 已经 8 个，`startsWith("pi")` 这类短前缀在 if 链里
 * 容易被将来的新 id 误伤。
 */
const CLAUDE_PATH = "…（保持原文件里的那一长串，不要改）";
const CODEX_PATH = "…（保持原文件里的那一长串，不要改）";

const CURSOR_PATH =
  "M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z";

const OPENCODE_INNER = "M716.8 819.2H307.2V409.6h409.6v409.6z";
const OPENCODE_FRAME = "M716.8 204.8H307.2v614.4h409.6V204.8z m204.8 819.2H102.4V0h819.2v1024z";

const PI_P = "M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z";
const PI_DOT = "M517.36 400 H634.72 V634.72 H517.36 Z";

type IconRenderer = (size: number) => React.ReactElement;

const BRANDS: { prefix: string; brand: string; render: IconRenderer }[] = [
  {
    prefix: "claude",
    brand: "claude",
    render: (size) => (
      <svg data-brand="claude" width={size} height={size} viewBox="0 0 1024 1024" fill="#D97757" aria-hidden>
        <path d={CLAUDE_PATH} />
      </svg>
    ),
  },
  {
    prefix: "codex",
    brand: "codex",
    render: (size) => (
      <svg data-brand="codex" width={size} height={size} viewBox="0 0 1089 1024" fill="currentColor" aria-hidden>
        <path d={CODEX_PATH} />
      </svg>
    ),
  },
  {
    prefix: "cursor",
    brand: "cursor",
    render: (size) => (
      <svg
        data-brand="cursor"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        aria-hidden
      >
        <path d={CURSOR_PATH} />
      </svg>
    ),
  },
  {
    prefix: "opencode",
    brand: "opencode",
    render: (size) => (
      // 两个 path 的顺序不能换：外框靠 nonzero 规则挖空，别加 fillRule。
      <svg data-brand="opencode" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
        <path d={OPENCODE_INNER} fill="#CFCECD" />
        <path d={OPENCODE_FRAME} fill="currentColor" />
      </svg>
    ),
  },
  {
    prefix: "pi",
    brand: "pi",
    render: (size) => (
      <svg data-brand="pi" width={size} height={size} viewBox="0 0 800 800" fill="currentColor" aria-hidden>
        {/* P 字里的洞靠 evenodd，丢了就变实心块 */}
        <path d={PI_P} fillRule="evenodd" />
        <path d={PI_DOT} />
      </svg>
    ),
  },
];

export function AgentBrandIcon({ agentId, size = 14 }: { agentId: string; size?: number }) {
  const hit = BRANDS.find((b) => agentId.startsWith(b.prefix));
  if (hit) return hit.render(size);
  return (
    <svg
      data-brand="generic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/hitl/`
Expected: PASS（新建的 4 个用例 + `HitlInlineCards.test.tsx` / `HandoffCard.test.tsx` 原有用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/hitl/agent-brand-icons.tsx src/sidepanel/components/hitl/agent-brand-icons.test.tsx
git commit -m "feat(sidepanel): Cursor / OpenCode / Pi 品牌图标 + 前缀查表化"
```

---

### Task 8: 全量验证 + 文档

**Files:**
- Modify: `CLAUDE.md`（Local daemon bridge 那段，把"支持 Claude Code + Codex"改成 8 条候选）

- [ ] **Step 1: 全量测试**

Run:
```bash
cd daemon && bun test && cd ..
pnpm test
pnpm typecheck
pnpm build
```
Expected: daemon 全绿；根 vitest 全绿；typecheck 0 错；build 成功

- [ ] **Step 2: 更新 CLAUDE.md**

在 `Architecture Invariants` 的 `Local daemon bridge` 条目里，把 agent 检测那句改成：

```
handoff 候选表（daemon/src/agents.ts）= 唯一 launch 权威（wire 只传 id）：Claude/Codex/Cursor
各 app+terminal 两形态 + OpenCode/Pi terminal，共 8 条；命令必须真机验证过才进表。detect 会问
用户 login shell 要 PATH（daemon 跑在 launchd 裸 PATH 下，否则一个 CLI 都看不见）并解出绝对路径，
start.command 里 exec 绝对路径。
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 同步 8 条 agent 候选表与 PATH 地基"
```

- [ ] **Step 4: 真机验收清单（PR 打 `need-human-test`，由人跑）**

装好 daemon（`launchctl kickstart -k gui/$(id -u)/ai.wiseria.pie` 重启它），然后：

1. 打开设置页「本地打通」→ 已安装的候选**全部出现**（重点：terminal 形态不再是瞎的。修复前只会看到 "Claude Code (App)"）
2. 让 LLM 交棒 → HandoffCard 列出已安装 ∩ 已启用的 agent，预选第一项
3. 交棒到每个已装的 terminal agent → 终端弹出、agent **自动开跑**、读到 context.md
   （claude 会停在它自己的交互审批上等你按 y —— 这是设计意图，不是 bug）
4. 交棒到 Claude.app / Codex(ChatGPT).app / Cursor.app → 目录作为工作区打开，引导文件正确
   （Claude → `CLAUDE.md`，Codex/Cursor → `AGENTS.md`）
5. 设置页关掉某个 agent → HandoffCard 不再列出它
6. 装一个新 agent（**不重启 daemon**）→ 重开设置页能看到（前提：装在 PATH 里已有的目录）
7. HandoffCard 与设置页上，Cursor / OpenCode / Pi 的品牌图标正确显示，且**暗色与浅色主题下都可见**

---

## Self-Review

**Spec 覆盖：**

| spec 章节 | 对应 task |
|---|---|
| §2 候选表终稿（8 条） | Task 3（codex-app）+ Task 6（其余） |
| §3.1 argv 模板 | Task 4 |
| §3.2 appPaths 合并 | Task 3 |
| §3.3 convention + RESERVED | Task 5 |
| §4 PATH 地基修复 | Task 1（探测）+ Task 2（绝对路径 spawn） |
| §5 真机验证 | Task 8 Step 4（验收清单） |
| §6 Cursor App 空工作区 | Task 6 表注释（已知取舍，无代码） |
| §7 不在范围（run_local_agent / 自定义条目 / MRU） | 无 task —— 故意不做 |
| §8 已知限制 | Task 8 Step 2（CLAUDE.md 记一笔） |
| 附录 A 图标 | Task 7 |

**类型一致性：** `DetectedAgent`（Task 2 定义）在 Task 3/4/5 的 handoff 里以 `agent.path` / `agent.argv` / `agent.convention` 消费，签名一致。`AgentBrandIcon({ agentId, size })`（Task 7）与 `HandoffCard.tsx:72` 现有调用一致。

**遗漏风险（已在任务里堵掉）：**
- `handoff.test.ts` 的 harness `detect` 在 Task 2 改带 `path`、Task 3 改 `appPaths![0]` —— 两处都写进了对应任务的步骤，不会漏。
- `daemon.ts` 的 `list_agents` **不用改**（map 的是 `AGENT_CANDIDATES` + detect 的 id 集，两个接口都没变）—— 已在 File Structure 注明，避免实现者去动它。
