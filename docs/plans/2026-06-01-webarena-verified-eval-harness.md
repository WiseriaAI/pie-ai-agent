# WebArena-Verified 评测 Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用真实 Chrome 加载的 Pie 扩展跑一个 WebArena-Verified 任务,抓 HAR + 取最终答案,经独立确定性评估器打出客观分数——不改动 agent loop 的生产代码。

**Architecture:** 三组件 + 胶水(文件/进程级边界):① 扩展内 dev-only Eval Bridge(`globalThis.__pieEval`,用 MockPort 复用现有 `runAgentLoop`);② Node Orchestrator(Playwright 启 Chrome+Pie、`serviceWorker.evaluate()` 驱动 bridge、`recordHar` 抓网络、清洗 key、落盘 artifact);③ 离线 Python Scorer(调 `webarena-verified` 评估器)。ground-truth 只来自 scorer,agent 自报的 `done` 仅作附加观测。

**Tech Stack:** TypeScript 6 · Vite 8(`define` flag 隔离 eval build)· Playwright(playwright-node)· vitest · Python 3 + `webarena-verified`(从源码装)· pytest

**Spec:** `docs/specs/2026-06-01-webarena-verified-eval-harness.md`

---

## File Structure

新增/改动文件及其单一职责:

**扩展侧(TS):**
- Create `src/background/eval-bridge.ts` — Eval Bridge:MockPort + `__pieEval` 方法(seedConfig/startTask/waitForDone/getTrace/reset),复用 `runAgentLoop`。dev-only。
- Create `src/background/eval-bridge.test.ts` — vitest 单测(mock chrome.* + 假 runAgentLoop 事件流)。
- Create `src/types/eval-bridge.d.ts` — `declare const __PIE_EVAL__: boolean`。
- Modify `src/background/index.ts` — 末尾加 `if (__PIE_EVAL__) import("./eval-bridge").then(m => m.mountEvalBridge())`。
- Modify `vite.config.ts` — `define.__PIE_EVAL__` + eval mode 切 `outDir=dist-eval`。
- Modify `package.json` — 加 `build:eval` / `verify:no-eval-bridge` / `eval:task` 脚本 + devDeps(`playwright`、`tsx`)。
- Create `scripts/assert-no-eval-bridge.mjs` — build-time invariant:prod `dist/` 不得含 `__pieEval`。

**Orchestrator(TS,`eval/runner/`):**
- Create `eval/runner/types.ts` — `EvalTrace` / `TaskDef` / `ArtifactBundle` 类型。
- Create `eval/runner/har-scrub.ts` — 纯函数:HAR 按 host 过滤 + 剥敏感 header。
- Create `eval/runner/har-scrub.test.ts` — vitest 单测。
- Create `eval/runner/launch.ts` — Playwright 启动 + SW handle 获取。
- Create `eval/runner/run-task.ts` — 一个 task 的编排时序 + 落盘。
- Create `eval/runner/cli.ts` — CLI 入口。

**Scorer(Python,`eval/scorer/`):**
- Create `eval/EVALUATOR_CONTRACT.md` — Task 0 spike 冻结的评估器 I/O 契约。
- Create `eval/scorer/score.py` — 读 artifact → 调评估器 → 写 `score.json`。
- Create `eval/scorer/test_score.py` — golden test(钉在契约上)。
- Create `eval/scorer/requirements.txt` — `webarena-verified` 依赖。
- Create `eval/scorer/fixtures/` — golden 假 artifact。

**胶水:**
- Create `eval/run-task.sh` — 先 orchestrator 再 scorer。
- Create `eval/README.md` — 环境搭建 + 手动运行说明。

---

## Task 0: 评估器契约 spike(gating,最高优先)

> 这一步冻结 `webarena-verified` 的真实 I/O。**Task 5(Scorer)依赖它**;若契约不可行,这是最便宜的 kill point。本任务是研究型,不走 TDD。

**Files:**
- Create: `eval/EVALUATOR_CONTRACT.md`
- Create: `eval/scorer/requirements.txt`

- [ ] **Step 1: 装 webarena-verified(从源码)**

Run:
```bash
python3 -m venv eval/.venv && source eval/.venv/bin/activate
pip install git+https://github.com/ServiceNow/webarena-verified.git
```
Expected: 安装成功。若失败,记录错误到 `EVALUATOR_CONTRACT.md` 的「安装」节,改用 `pip install browsergym-webarena-verified` 作为 fallback 并标注差异。

- [ ] **Step 2: 定位评估入口并探明签名**

Run:
```bash
source eval/.venv/bin/activate
python3 -c "import webarena_verified, inspect, pkgutil; print([m.name for m in pkgutil.iter_modules(webarena_verified.__path__)])"
```
找到 evaluate/score 函数(可能名为 `evaluate`/`score_task`/`Evaluator`)。用 `inspect.signature(...)` 打印其参数。

记录到 `EVALUATOR_CONTRACT.md`:函数全名、import 路径、**入参签名**(它吃 task_id 还是 task dict?吃 agent answer 字符串还是结构体?吃 HAR 路径还是已解析对象?)。

- [ ] **Step 3: 手搓最小假 artifact 跑一次**

挑一个已知信息检索类 WebArena 任务(如 task_id 0)。手写一份「正确答案」字符串。用一段最小 HAR(可先空 entries:`{"log":{"version":"1.2","entries":[]}}`)。直接调评估器。

记录到 `EVALUATOR_CONTRACT.md`:
- **answer 格式**:纯字符串?要 `{answer: "..."}` 结构?
- **HAR 要求**:信息检索类是否需要 HAR(可能只看 answer)?状态改变类需要哪些 entry 字段(request.url / postData / response.status / response body)?认哪些 host?
- **输出形状**:返回 float(0~1)还是 bool 还是 `{score, status, ...}`?字段名是什么?

- [ ] **Step 4: 确认两类任务的离线可打分性**

再挑一个已知状态改变类任务,确认能否仅凭 (answer + HAR) 离线打分、不连 live DB。

记录到 `EVALUATOR_CONTRACT.md` 的「任务类型支持」节:信息检索类 ✅/❌、状态改变类 ✅/❌。**若状态改变类需要 live DB,明确写「v1 out-of-scope,scorer 对该类返回 status=unsupported」。**

- [ ] **Step 5: 冻结契约文档 + 写 requirements**

`eval/EVALUATOR_CONTRACT.md` 须包含:安装命令、评估器 import 路径与函数签名、answer 格式、HAR schema 要求(含 host 白名单)、输出形状(精确字段名)、任务类型支持矩阵。

`eval/scorer/requirements.txt` 写入实际可用的安装来源(Step 1 确认的那个)。

- [ ] **Step 6: Commit**

```bash
git add eval/EVALUATOR_CONTRACT.md eval/scorer/requirements.txt
git commit -m "docs(eval): freeze webarena-verified evaluator contract (spike)"
```

---

## Task 1: HAR scrub 纯函数

**Files:**
- Create: `eval/runner/types.ts`
- Create: `eval/runner/har-scrub.ts`
- Test: `eval/runner/har-scrub.test.ts`

- [ ] **Step 1: 写类型**

`eval/runner/types.ts`:
```ts
export interface HarHeader { name: string; value: string }
export interface HarEntry {
  request: { url: string; headers: HarHeader[] };
  response: { headers: HarHeader[] };
  [k: string]: unknown;
}
export interface Har { log: { entries: HarEntry[]; [k: string]: unknown }; [k: string]: unknown }

export interface TaskDef {
  taskId: string;
  goal: string;
  startUrl: string;
  evalType: "info-seeking" | "state-changing";
  /** WebArena host 白名单,用于 HAR 过滤(如 ["shop.webarena.local"])。 */
  webarenaHosts: string[];
}

export interface EvalTrace {
  sessionId: string;
  agentSelfReport: { success: boolean; summary: string };
  answer: string;
  steps: Array<{ stepIndex: number; tool: string; argsRedacted: unknown; status: string }>;
  usage: { inputTokens: number; outputTokens: number };
  startedAt: number;
  endedAt: number;
  error: string | null;
}

export type RunStatus = "done" | "timeout" | "error" | "harness-error";
```

- [ ] **Step 2: 写 failing test**

`eval/runner/har-scrub.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { scrubHar } from "./har-scrub";
import type { Har } from "./types";

const sampleHar = (): Har => ({
  log: {
    entries: [
      { request: { url: "https://api.anthropic.com/v1/messages", headers: [{ name: "Authorization", value: "Bearer sk-secret" }] }, response: { headers: [] } },
      { request: { url: "https://shop.webarena.local/cart", headers: [{ name: "Cookie", value: "session=abc" }, { name: "Accept", value: "*/*" }] }, response: { headers: [{ name: "Set-Cookie", value: "x=y" }] } },
    ],
  },
});

describe("scrubHar", () => {
  it("drops entries whose host is not in the allow-list (removes the BYOK-key-bearing provider call)", () => {
    const out = scrubHar(sampleHar(), ["shop.webarena.local"]);
    expect(out.log.entries).toHaveLength(1);
    expect(out.log.entries[0].request.url).toContain("shop.webarena.local");
    expect(JSON.stringify(out)).not.toContain("sk-secret");
  });

  it("strips sensitive headers from kept entries", () => {
    const out = scrubHar(sampleHar(), ["shop.webarena.local"]);
    const reqHeaderNames = out.log.entries[0].request.headers.map((h) => h.name.toLowerCase());
    expect(reqHeaderNames).not.toContain("cookie");
    expect(reqHeaderNames).toContain("accept");
    const resHeaderNames = out.log.entries[0].response.headers.map((h) => h.name.toLowerCase());
    expect(resHeaderNames).not.toContain("set-cookie");
  });

  it("does not mutate the input", () => {
    const input = sampleHar();
    scrubHar(input, ["shop.webarena.local"]);
    expect(input.log.entries).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run test — verify fail**

Run: `pnpm test eval/runner/har-scrub.test.ts`
Expected: FAIL（`scrubHar` 未定义 / 模块不存在）。

- [ ] **Step 4: 实现**

`eval/runner/har-scrub.ts`:
```ts
import type { Har, HarHeader } from "./types";

/** 默认剥掉的敏感 header(大小写不敏感)。WebArena 的 session cookie 默认也剥;
 *  若 Task 0 契约确认评估器需要保留 cookie 做 trace replay,把 "cookie"/"set-cookie"
 *  从这里移除,并在 EVALUATOR_CONTRACT.md 记录。 */
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"]);

function stripHeaders(headers: HarHeader[]): HarHeader[] {
  return headers.filter((h) => !SENSITIVE_HEADERS.has(h.name.toLowerCase()));
}

/** 只保留 host 在 allowedHosts 的 entry(provider 调用因此被整条剔除,BYOK key 不落盘),
 *  并剥掉保留 entry 上的敏感 header。返回新对象,不改输入。 */
export function scrubHar(har: Har, allowedHosts: string[]): Har {
  const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const entries = har.log.entries
    .filter((e) => {
      try {
        return hosts.has(new URL(e.request.url).host.toLowerCase());
      } catch {
        return false;
      }
    })
    .map((e) => ({
      ...e,
      request: { ...e.request, headers: stripHeaders(e.request.headers) },
      response: { ...e.response, headers: stripHeaders(e.response.headers) },
    }));
  return { ...har, log: { ...har.log, entries } };
}
```

- [ ] **Step 5: Run test — verify pass**

Run: `pnpm test eval/runner/har-scrub.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 6: Commit**

```bash
git add eval/runner/types.ts eval/runner/har-scrub.ts eval/runner/har-scrub.test.ts
git commit -m "feat(eval): HAR host-filter + sensitive-header scrub (pure fn)"
```

---

## Task 2: Eval Bridge(MockPort + trace 收集)

> bridge 复用 `runAgentLoop`(`src/lib/agent/loop.ts:899`,ctx 形状见 `AgentLoopContext`)。`runAgentLoop` 只调 `port.postMessage(msg)`,故 MockPort 只需实现 `postMessage` + 满足 `chrome.runtime.Port` 类型的空 stub。SW→panel 消息类型见 `src/types/messages.ts`(`AgentDoneTaskMessage`/`AgentStepMessage`/`ChatErrorMessage`/`AgentUsageMessage`)。

**Files:**
- Create: `src/background/eval-bridge.ts`
- Test: `src/background/eval-bridge.test.ts`

- [ ] **Step 1: 写 failing test（MockPort 收集 + getTrace 抽答案）**

`src/background/eval-bridge.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// runAgentLoop 在测试里被替换成一个「按预设事件序列回灌 MockPort」的假实现。
const fakeRun = vi.fn();
vi.mock("@/lib/agent/loop", () => ({ runAgentLoop: (ctx: any) => fakeRun(ctx) }));
vi.mock("@/lib/instances", () => ({
  createInstance: vi.fn(async () => "inst-1"),
  setActiveInstance: vi.fn(async () => {}),
  resolveInstanceToModelConfig: vi.fn(async () => ({ provider: "anthropic", model: "claude", apiKey: "k" })),
}));

import { __makeBridgeForTest } from "./eval-bridge";

beforeEach(() => {
  fakeRun.mockReset();
  (globalThis as any).chrome = {
    tabs: { query: vi.fn(async () => [{ id: 7, url: "https://shop.webarena.local/" }]) },
    storage: { local: { clear: vi.fn(async () => {}) } },
  };
});

describe("eval bridge getTrace", () => {
  it("extracts the final answer from the terminating done step and reports usage", async () => {
    // fakeRun: 模拟 loop 往 port 灌 agent-step(done) + agent-usage + agent-done-task
    fakeRun.mockImplementation(async (ctx: any) => {
      ctx.port.postMessage({ type: "agent-step", stepIndex: 1, tool: "read_page", args: {}, status: "ok", sessionId: ctx.sessionId });
      ctx.port.postMessage({ type: "agent-step", stepIndex: 2, tool: "done", args: { summary: "The price is $42" }, status: "ok", sessionId: ctx.sessionId });
      ctx.port.postMessage({ type: "agent-usage", sessionId: ctx.sessionId, lastInputTokens: 10, lastOutputTokens: 5, totalInputTokens: 100, totalOutputTokens: 50 });
      ctx.port.postMessage({ type: "agent-done-task", success: true, summary: "The price is $42", stepCount: 2, sessionId: ctx.sessionId });
    });
    const bridge = __makeBridgeForTest();
    const { sessionId } = await bridge.startTask({ goal: "find price" });
    const done = await bridge.waitForDone({ sessionId, timeoutMs: 1000 });
    expect(done.status).toBe("done");
    const trace = await bridge.getTrace({ sessionId });
    expect(trace.answer).toBe("The price is $42");
    expect(trace.agentSelfReport.success).toBe(true);
    expect(trace.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(trace.steps).toHaveLength(2);
  });

  it("resolves waitForDone with status=error on chat-error", async () => {
    fakeRun.mockImplementation(async (ctx: any) => {
      ctx.port.postMessage({ type: "chat-error", error: "boom", sessionId: ctx.sessionId });
    });
    const bridge = __makeBridgeForTest();
    const { sessionId } = await bridge.startTask({ goal: "x" });
    const done = await bridge.waitForDone({ sessionId, timeoutMs: 1000 });
    expect(done.status).toBe("error");
    expect((await bridge.getTrace({ sessionId })).error).toBe("boom");
  });

  it("resolves waitForDone with status=timeout when nothing terminates", async () => {
    fakeRun.mockImplementation(async () => { /* never posts a terminal event */ });
    const bridge = __makeBridgeForTest();
    const { sessionId } = await bridge.startTask({ goal: "x" });
    const done = await bridge.waitForDone({ sessionId, timeoutMs: 50 });
    expect(done.status).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run test — verify fail**

Run: `pnpm test src/background/eval-bridge.test.ts`
Expected: FAIL（`__makeBridgeForTest` 未定义）。

- [ ] **Step 3: 实现 eval-bridge.ts**

`src/background/eval-bridge.ts`:
```ts
import { runAgentLoop } from "@/lib/agent/loop";
import { createInstance, setActiveInstance, resolveInstanceToModelConfig } from "@/lib/instances";
import type { PortMessageToPanel } from "@/types/messages";

interface SessionRun {
  buffer: PortMessageToPanel[];
  controller: AbortController;
  startedAt: number;
  endedAt: number;
  terminal: "done" | "error" | "timeout" | null;
  resolveDone: ((s: "done" | "error" | "timeout") => void) | null;
}

/** 满足 chrome.runtime.Port 形状的最小实现:runAgentLoop 只调 postMessage。 */
function makeMockPort(sessionId: string, onMsg: (m: PortMessageToPanel) => void): chrome.runtime.Port {
  const noop = { addListener() {}, removeListener() {}, hasListener: () => false } as any;
  return {
    name: `chat-stream-${sessionId}`,
    postMessage: (m: PortMessageToPanel) => onMsg(m),
    disconnect() {},
    onMessage: noop,
    onDisconnect: noop,
  } as unknown as chrome.runtime.Port;
}

function makeBridge() {
  const runs = new Map<string, SessionRun>();
  let seededInstanceId: string | null = null;
  let seq = 0;

  function onMessage(sessionId: string, m: PortMessageToPanel) {
    const run = runs.get(sessionId);
    if (!run) return;
    run.buffer.push(m);
    if (m.type === "agent-done-task" || m.type === "chat-error") {
      run.endedAt = Date.now();
      run.terminal = m.type === "agent-done-task" ? "done" : "error";
      run.resolveDone?.(run.terminal);
      run.resolveDone = null;
    }
  }

  return {
    async seedConfig(cfg: { provider: string; model: string; apiKey: string }) {
      // builtin provider 路径(anthropic/openai/...);custom provider baseUrl v1 不支持。
      const id = await createInstance({ provider: cfg.provider as any, nickname: "eval", apiKey: cfg.apiKey, model: cfg.model });
      await setActiveInstance(id);
      seededInstanceId = id;
      return { instanceId: id };
    },

    async startTask(opts: { goal: string }) {
      const sessionId = `eval-${++seq}`;
      const controller = new AbortController();
      const run: SessionRun = { buffer: [], controller, startedAt: Date.now(), endedAt: 0, terminal: null, resolveDone: null };
      runs.set(sessionId, run);

      const instanceId = seededInstanceId ?? "";
      const modelConfig = await resolveInstanceToModelConfig(instanceId);
      if (!modelConfig) throw new Error("eval bridge: seedConfig must be called before startTask");

      // pin 当前 active tab(orchestrator 已先导航到任务起始 URL)
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const pinnedTabs = tab?.id != null ? [{ tabId: tab.id, origin: new URL(tab.url ?? "about:blank").origin }] : [];

      // 包一句:让 agent 把最终答案放进 done 的 summary
      const task = `${opts.goal}\n\nWhen the task is complete, call the \`done\` tool with your final answer as its \`summary\`.`;

      // fire-and-forget:loop 跑到 done/fail/abort 自然结束;事件经 MockPort 进 buffer
      void runAgentLoop({
        port: makeMockPort(sessionId, (m) => onMessage(sessionId, m)),
        task,
        modelConfig,
        signal: controller.signal,
        sessionId,
        pinnedTabs,
        initialFocusTabId: pinnedTabs[0]?.tabId,
      }).catch((e) => onMessage(sessionId, { type: "chat-error", error: e instanceof Error ? e.message : String(e), sessionId }));

      return { sessionId };
    },

    waitForDone(opts: { sessionId: string; timeoutMs: number }): Promise<{ status: "done" | "error" | "timeout" }> {
      const run = runs.get(opts.sessionId);
      if (!run) return Promise.resolve({ status: "error" });
      if (run.terminal) return Promise.resolve({ status: run.terminal });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          run.terminal = "timeout";
          run.endedAt = Date.now();
          run.controller.abort();
          resolve({ status: "timeout" });
        }, opts.timeoutMs);
        run.resolveDone = (s) => {
          clearTimeout(timer);
          resolve({ status: s });
        };
      });
    },

    async getTrace(opts: { sessionId: string }) {
      const run = runs.get(opts.sessionId);
      if (!run) throw new Error(`eval bridge: unknown session ${opts.sessionId}`);
      const steps = run.buffer
        .filter((m): m is Extract<PortMessageToPanel, { type: "agent-step" }> => m.type === "agent-step")
        .map((m) => ({ stepIndex: m.stepIndex, tool: m.tool, argsRedacted: m.args, status: m.status }));
      const doneStep = [...steps].reverse().find((s) => s.tool === "done");
      const doneTask = run.buffer.find((m): m is Extract<PortMessageToPanel, { type: "agent-done-task" }> => m.type === "agent-done-task");
      const errMsg = run.buffer.find((m): m is Extract<PortMessageToPanel, { type: "chat-error" }> => m.type === "chat-error");
      const lastUsage = [...run.buffer].reverse().find((m): m is Extract<PortMessageToPanel, { type: "agent-usage" }> => m.type === "agent-usage");
      const answer = ((doneStep?.argsRedacted as { summary?: string } | undefined)?.summary ?? doneTask?.summary ?? "").trim();
      return {
        sessionId: opts.sessionId,
        agentSelfReport: { success: doneTask?.success ?? false, summary: doneTask?.summary ?? "" },
        answer,
        steps,
        usage: { inputTokens: lastUsage?.totalInputTokens ?? 0, outputTokens: lastUsage?.totalOutputTokens ?? 0 },
        startedAt: run.startedAt,
        endedAt: run.endedAt || Date.now(),
        error: errMsg?.error ?? null,
      };
    },

    async reset(opts?: { keepConfig?: boolean }) {
      for (const run of runs.values()) run.controller.abort();
      runs.clear();
      await chrome.storage.local.clear();
      if (opts?.keepConfig && seededInstanceId) {
        // keepConfig 时重建 instance 的责任留给调用方重新 seedConfig;clear 已抹掉存储。
        seededInstanceId = null;
      } else {
        seededInstanceId = null;
      }
    },
  };
}

export type EvalBridge = ReturnType<typeof makeBridge>;

/** SW 启动时(仅 eval build)挂到全局,供 Playwright serviceWorker.evaluate() 调用。 */
export function mountEvalBridge(): void {
  (globalThis as unknown as { __pieEval?: EvalBridge }).__pieEval = makeBridge();
}

/** 单测专用:直接拿一个 bridge 实例,不挂全局。 */
export function __makeBridgeForTest(): EvalBridge {
  return makeBridge();
}
```

- [ ] **Step 4: Run test — verify pass**

Run: `pnpm test src/background/eval-bridge.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/background/eval-bridge.ts src/background/eval-bridge.test.ts
git commit -m "feat(eval): dev-only eval bridge with MockPort reusing runAgentLoop"
```

---

## Task 3: dev-only 构建隔离 + build invariant

> 用 Vite `define` 把 `__PIE_EVAL__` 静态替换:prod=false → `if(__PIE_EVAL__) import(...)` 死分支被 tree-shake,eval-bridge 不进 `dist/`。eval build 切 `outDir=dist-eval`。invariant 脚本 grep prod dist 兜底。

**Files:**
- Create: `src/types/eval-bridge.d.ts`
- Modify: `src/background/index.ts`（文件末尾）
- Modify: `vite.config.ts:29-48`
- Modify: `package.json:7-13`（scripts）
- Create: `scripts/assert-no-eval-bridge.mjs`

- [ ] **Step 1: 声明全局 flag 类型**

`src/types/eval-bridge.d.ts`:
```ts
/** Vite define 注入。prod build 恒为 false(死分支被 tree-shake)。 */
declare const __PIE_EVAL__: boolean;
```

- [ ] **Step 2: 在 SW 末尾挂载(仅 eval build)**

`src/background/index.ts` 文件最末尾追加:
```ts
// --- Eval harness (dev-only) ---
// __PIE_EVAL__ 由 Vite define 静态替换:prod=false → 整个 import 被 tree-shake,
// eval-bridge.ts 不进 dist/(由 scripts/assert-no-eval-bridge.mjs 在 CI 兜底)。
if (__PIE_EVAL__) {
  import("./eval-bridge").then((m) => m.mountEvalBridge());
}
```

- [ ] **Step 3: vite.config.ts 加 define + eval outDir**

把 `export default defineConfig({...})` 改为函数式以读取 `mode`。`vite.config.ts:29` 起替换为:
```ts
export default defineConfig(({ mode }) => {
  const isEval = mode === "eval";
  return {
    plugins: [react(), tailwindcss(), crx({ manifest }), copyLiteparseWasm()],
    define: {
      __PIE_EVAL__: JSON.stringify(isEval),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    build: {
      outDir: isEval ? "dist-eval" : "dist",
      rollupOptions: {
        input: {
          "offscreen-pdf-parser": path.resolve(__dirname, "src/offscreen/pdf-parser.html"),
        },
      },
    },
  };
});
```

- [ ] **Step 4: package.json scripts + devDeps**

`package.json` 的 `scripts` 加入:
```json
    "build:eval": "pnpm icons && vite build --mode eval",
    "verify:no-eval-bridge": "node scripts/assert-no-eval-bridge.mjs",
    "eval:task": "tsx eval/runner/cli.ts"
```
`devDependencies` 加入(版本以 `pnpm add -D` 实装为准):
```json
    "playwright": "^1.50.0",
    "tsx": "^4.19.0"
```
Run: `pnpm add -D playwright tsx`
Expected: 安装成功,lockfile 更新。

- [ ] **Step 5: 写 invariant 脚本**

`scripts/assert-no-eval-bridge.mjs`:
```js
#!/usr/bin/env node
// Build-time invariant: 生产 dist/ 绝不能含 eval bridge 痕迹。
// 仿 tool-names.ts / tools.ts 的「构建期不变量」文化:违反即非零退出,CI fail。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const NEEDLES = ["__pieEval", "mountEvalBridge", "eval-bridge"];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const hits = [];
for (const file of walk(DIST)) {
  if (!/\.(js|html|map)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const needle of NEEDLES) if (text.includes(needle)) hits.push(`${file} :: ${needle}`);
}

if (hits.length) {
  console.error("✗ eval bridge leaked into production dist/:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("✓ no eval bridge in production dist/");
```

- [ ] **Step 6: 验证 prod build 干净**

Run: `pnpm build && pnpm verify:no-eval-bridge`
Expected: build 成功;脚本打印 `✓ no eval bridge in production dist/` 并 0 退出。

- [ ] **Step 7: 验证 eval build 含 bridge**

Run: `pnpm build:eval && grep -rl "__pieEval" dist-eval >/dev/null && echo "EVAL_BUILD_OK"`
Expected: 打印 `EVAL_BUILD_OK`（eval build 里确实含 `__pieEval`)。

- [ ] **Step 8: 确认全量测试 + 主构建未被破坏**

Run: `pnpm test && pnpm build`
Expected: 全绿;`dist/manifest.json` 正常生成。

- [ ] **Step 9: Commit**

```bash
git add src/types/eval-bridge.d.ts src/background/index.ts vite.config.ts package.json pnpm-lock.yaml scripts/assert-no-eval-bridge.mjs
git commit -m "build(eval): __PIE_EVAL__ define gate + dist invariant + build:eval"
```

---

## Task 4: Node Orchestrator(Playwright)

> 非单元 TDD(需真 Chrome);验证靠 Task 6 的 E2E smoke。HAR scrub(Task 1)已单测覆盖。`serviceWorker.evaluate()` 拿 SW handle 调 `__pieEval.*`。

**Files:**
- Create: `eval/runner/launch.ts`
- Create: `eval/runner/run-task.ts`
- Create: `eval/runner/cli.ts`

- [ ] **Step 1: 写 launch.ts(启动 + SW handle)**

`eval/runner/launch.ts`:
```ts
import { chromium, type BrowserContext, type Worker } from "playwright";
import path from "node:path";

export interface LaunchResult {
  context: BrowserContext;
  serviceWorker: Worker;
  harPath: string;
}

/** 启一个带 Pie(dist-eval)的持久化 Chrome,开 recordHar,等扩展 SW active。 */
export async function launchPieChrome(opts: { userDataDir: string; harPath: string }): Promise<LaunchResult> {
  const distEval = path.resolve("dist-eval");
  const context = await chromium.launchPersistentContext(opts.userDataDir, {
    headless: false, // MV3 扩展需有头
    args: [`--disable-extensions-except=${distEval}`, `--load-extension=${distEval}`],
    recordHar: { path: opts.harPath, content: "embed" },
  });
  // 等扩展 Service Worker 注册
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  return { context, serviceWorker: sw, harPath: opts.harPath };
}
```

- [ ] **Step 2: 写 run-task.ts(编排时序 + 落盘)**

`eval/runner/run-task.ts`:
```ts
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { launchPieChrome } from "./launch";
import { scrubHar } from "./har-scrub";
import type { TaskDef, EvalTrace, RunStatus, Har } from "./types";

export interface ModelEnv { provider: string; model: string; apiKey: string }

export interface RunResult { runDir: string; status: RunStatus; trace: EvalTrace | null }

/** 跑一个 task:启 Chrome+Pie → seed key → 导航 → startTask → waitForDone →
 *  getTrace → reset → 关 context(flush HAR)→ 清洗 HAR → 落盘 artifact bundle。 */
export async function runOneTask(opts: {
  task: TaskDef;
  model: ModelEnv;
  outRoot: string;
  stamp: string;
  timeoutMs: number;
}): Promise<RunResult> {
  const runDir = path.join(opts.outRoot, `${opts.task.taskId}-${opts.stamp}`);
  mkdirSync(runDir, { recursive: true });
  const harPath = path.join(runDir, "network.raw.har");
  const userDataDir = path.join(runDir, "profile");

  let status: RunStatus = "harness-error";
  let trace: EvalTrace | null = null;

  const { context, serviceWorker } = await launchPieChrome({ userDataDir, harPath });
  try {
    await serviceWorker.evaluate(async (cfg) => {
      await (globalThis as any).__pieEval.seedConfig(cfg);
    }, opts.model);

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(opts.task.startUrl, { waitUntil: "domcontentloaded" });

    const { sessionId } = await serviceWorker.evaluate(
      async (goal) => (globalThis as any).__pieEval.startTask({ goal }),
      opts.task.goal,
    );

    const done = await serviceWorker.evaluate(
      async (args) => (globalThis as any).__pieEval.waitForDone(args),
      { sessionId, timeoutMs: opts.timeoutMs },
    );
    status = done.status as RunStatus;

    trace = await serviceWorker.evaluate(
      async (args) => (globalThis as any).__pieEval.getTrace(args),
      { sessionId },
    );

    await serviceWorker.evaluate(async () => (globalThis as any).__pieEval.reset());
  } catch (e) {
    status = "harness-error";
    trace = trace ?? null;
    console.error("[orchestrator] harness error:", e);
  } finally {
    await context.close(); // flush HAR
  }

  // 清洗 HAR(剔除 provider 调用 / 剥敏感 header),写最终 network.har,删原始
  const rawHar = JSON.parse(readFileSync(harPath, "utf8")) as Har;
  const cleanHar = scrubHar(rawHar, opts.task.webarenaHosts);
  writeFileSync(path.join(runDir, "network.har"), JSON.stringify(cleanHar, null, 2));
  rmSync(harPath, { force: true });

  // artifact bundle
  writeFileSync(path.join(runDir, "task.json"), JSON.stringify(opts.task, null, 2));
  if (trace) {
    writeFileSync(path.join(runDir, "run.json"), JSON.stringify(trace, null, 2));
    writeFileSync(path.join(runDir, "answer.txt"), trace.answer);
  }
  writeFileSync(
    path.join(runDir, "meta.json"),
    JSON.stringify({ model: opts.model.model, provider: opts.model.provider, status, stamp: opts.stamp }, null, 2),
  );

  // profile 用完即弃(强隔离)
  rmSync(userDataDir, { recursive: true, force: true });

  return { runDir, status, trace };
}
```

- [ ] **Step 3: 写 cli.ts**

`eval/runner/cli.ts`:
```ts
import { readFileSync } from "node:fs";
import { runOneTask } from "./run-task";
import type { TaskDef } from "./types";

// 用法: tsx eval/runner/cli.ts <task.json 路径> [outRoot]
// 需要环境变量: PIE_EVAL_PROVIDER / PIE_EVAL_MODEL / PIE_EVAL_API_KEY
async function main() {
  const taskPath = process.argv[2];
  const outRoot = process.argv[3] ?? "eval/runs";
  if (!taskPath) throw new Error("usage: tsx eval/runner/cli.ts <task.json> [outRoot]");

  const task = JSON.parse(readFileSync(taskPath, "utf8")) as TaskDef;
  const model = {
    provider: requireEnv("PIE_EVAL_PROVIDER"),
    model: requireEnv("PIE_EVAL_MODEL"),
    apiKey: requireEnv("PIE_EVAL_API_KEY"),
  };
  const stamp = String(Date.now());
  const res = await runOneTask({ task, model, outRoot, stamp, timeoutMs: 5 * 60_000 });
  console.log(`[orchestrator] status=${res.status} runDir=${res.runDir}`);
  if (res.status === "harness-error") process.exit(2);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: 类型检查通过**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep -i "eval/runner" || echo "NO_EVAL_TS_ERRORS"`
Expected: 打印 `NO_EVAL_TS_ERRORS`(eval/runner 下无类型错误)。若 `tsconfig` 不含 `eval/`,在 `include` 加 `"eval/**/*.ts"` 或用 `tsx --check`;以无 eval/runner 报错为准。

- [ ] **Step 5: Commit**

```bash
git add eval/runner/launch.ts eval/runner/run-task.ts eval/runner/cli.ts
git commit -m "feat(eval): Playwright orchestrator — launch, run-task, CLI"
```

---

## Task 5: Python Scorer

> **依赖 Task 0 冻结的 `eval/EVALUATOR_CONTRACT.md`。** 下面 artifact 加载 / `score.json` schema / golden test 是完整的;唯一按契约填的是 `call_evaluator()` 内对 `webarena_verified` 的真实调用——按契约的「函数签名 / answer 格式 / 输出形状」三节落实。

**Files:**
- Create: `eval/scorer/score.py`
- Create: `eval/scorer/test_score.py`
- Create: `eval/scorer/fixtures/correct/`（task.json + answer.txt + network.har）
- Create: `eval/scorer/fixtures/wrong/`（同结构,答案错误）

- [ ] **Step 1: 造 golden fixtures**

按 Task 0 选定的已知任务,创建两份 fixture 目录。`eval/scorer/fixtures/correct/task.json`:
```json
{ "taskId": "0", "goal": "...", "startUrl": "...", "evalType": "info-seeking", "webarenaHosts": ["shop.webarena.local"] }
```
`eval/scorer/fixtures/correct/answer.txt`:写入 Task 0 验证过的**正确**答案字符串。
`eval/scorer/fixtures/correct/network.har`:`{"log":{"version":"1.2","entries":[]}}`(信息检索类若契约确认不需 HAR)。
`eval/scorer/fixtures/wrong/`:同结构,`answer.txt` 写一个**已知错误**答案。

- [ ] **Step 2: 写 failing test**

`eval/scorer/test_score.py`:
```python
import json, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).parent
SCORE = ROOT / "score.py"

def run_scorer(run_dir: pathlib.Path) -> dict:
    subprocess.run([sys.executable, str(SCORE), str(run_dir)], check=True)
    return json.loads((run_dir / "score.json").read_text())

def test_correct_answer_scores_pass(tmp_path):
    src = ROOT / "fixtures" / "correct"
    dst = tmp_path / "correct"
    dst.mkdir()
    for f in ("task.json", "answer.txt", "network.har"):
        (dst / f).write_text((src / f).read_text())
    out = run_scorer(dst)
    assert out["status"] == "scored"
    assert out["score"] == 1.0  # 按 EVALUATOR_CONTRACT.md 的输出形状调整(若是 bool 改 True)

def test_wrong_answer_scores_fail(tmp_path):
    src = ROOT / "fixtures" / "wrong"
    dst = tmp_path / "wrong"
    dst.mkdir()
    for f in ("task.json", "answer.txt", "network.har"):
        (dst / f).write_text((src / f).read_text())
    out = run_scorer(dst)
    assert out["status"] == "scored"
    assert out["score"] == 0.0
```

- [ ] **Step 3: Run test — verify fail**

Run: `cd eval && source .venv/bin/activate && pytest scorer/test_score.py -v`
Expected: FAIL（`score.py` 不存在）。

- [ ] **Step 4: 实现 score.py**

`eval/scorer/score.py`(`call_evaluator` 按 `EVALUATOR_CONTRACT.md` 落实):
```python
#!/usr/bin/env python3
"""读一个 artifact run 目录 → 调 webarena-verified 确定性评估器 → 写 score.json。
纯离线、无 Chrome/无 Pie。ground-truth 唯一来源。"""
import json, sys, pathlib

def call_evaluator(task: dict, answer: str, har: dict) -> dict:
    """按 EVALUATOR_CONTRACT.md「函数签名 / answer 格式 / 输出形状」三节实现。
    以下为占位最可能形状,执行时按冻结契约对齐字段名与调用方式:
        from webarena_verified import evaluate            # ← 契约 Step 2 确认的真实 import
        result = evaluate(task_id=int(task["taskId"]),    # ← 契约确认入参形状
                          response=answer,
                          network_trace=har)
        return {"score": float(result.score), "raw": result.as_dict()}
    """
    from webarena_verified import evaluate  # 按契约替换为真实符号
    result = evaluate(task_id=int(task["taskId"]), response=answer, network_trace=har)
    score = float(getattr(result, "score", result))
    return {"score": score, "raw": getattr(result, "as_dict", lambda: {})()}

def main() -> int:
    run_dir = pathlib.Path(sys.argv[1])
    task = json.loads((run_dir / "task.json").read_text())
    answer = (run_dir / "answer.txt").read_text() if (run_dir / "answer.txt").exists() else ""
    har = json.loads((run_dir / "network.har").read_text())

    out = {"taskId": task["taskId"], "evaluator": "webarena-verified"}
    # 状态改变类若契约判为 v1 不支持 → 直接 unsupported(见 EVALUATOR_CONTRACT.md 任务类型矩阵)
    if task.get("evalType") == "state-changing" and not SUPPORTS_STATE_CHANGING:
        out.update({"status": "unsupported", "score": None})
    else:
        try:
            res = call_evaluator(task, answer, har)
            out.update({"status": "scored", "score": res["score"], "details": res["raw"]})
        except Exception as e:  # 评估器崩 / 契约漂移 → 保留 artifact,记 scorer-error
            out.update({"status": "scorer-error", "score": None, "error": repr(e)})

    (run_dir / "score.json").write_text(json.dumps(out, indent=2))
    print(f"[scorer] {out['status']} score={out.get('score')}")
    return 0

# Task 0 矩阵确认后改这里(True/False)
SUPPORTS_STATE_CHANGING = False

if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run test — verify pass**

Run: `cd eval && source .venv/bin/activate && pytest scorer/test_score.py -v`
Expected: PASS（2 passed）。若 `score`/`status` 字段名或值类型与契约不符,改 test 与 `call_evaluator` 对齐后再绿。

- [ ] **Step 6: Commit**

```bash
git add eval/scorer/score.py eval/scorer/test_score.py eval/scorer/fixtures
git commit -m "feat(eval): offline deterministic scorer + golden tests"
```

---

## Task 6: 胶水脚本 + E2E smoke + README

> 把 orchestrator(产出 artifact)与 scorer(打分)串成一条命令,跑一个真实 WebArena-Verified 任务验证全链路。E2E 手动(本地稳定前不进 CI)。

**Files:**
- Create: `eval/run-task.sh`
- Create: `eval/README.md`

- [ ] **Step 1: 写胶水脚本**

`eval/run-task.sh`:
```bash
#!/usr/bin/env bash
# 用法: PIE_EVAL_PROVIDER=anthropic PIE_EVAL_MODEL=... PIE_EVAL_API_KEY=... \
#        eval/run-task.sh <task.json>
# 前置: pnpm build:eval 已生成 dist-eval/;WebArena docker 已起;eval/.venv 已装 scorer。
set -euo pipefail
TASK_JSON="${1:?usage: run-task.sh <task.json>}"
OUT_ROOT="eval/runs"

# 1) Orchestrator:跑 agent,产出 artifact bundle
RUN_LINE=$(pnpm -s eval:task "$TASK_JSON" "$OUT_ROOT" | tee /dev/stderr | grep "runDir=")
RUN_DIR="${RUN_LINE##*runDir=}"

# 2) Scorer:离线确定性打分
source eval/.venv/bin/activate
python3 eval/scorer/score.py "$RUN_DIR"

echo "=== score.json ==="
cat "$RUN_DIR/score.json"
```
Run: `chmod +x eval/run-task.sh`

- [ ] **Step 2: 写 README(环境搭建 + 运行)**

`eval/README.md` 须包含:
```markdown
# Pie WebArena-Verified 评测 Harness

## 一次性搭建
1. 起 WebArena docker(按官方 https://github.com/web-arena-x/webarena/blob/main/environment_docker/README.md),
   记下各站点 host,写进任务的 `webarenaHosts`。
2. `pnpm build:eval` → 生成 dist-eval/。
3. `python3 -m venv eval/.venv && source eval/.venv/bin/activate && pip install -r eval/scorer/requirements.txt`
4. `pnpm exec playwright install chromium`

## 跑一个任务
\`\`\`bash
export PIE_EVAL_PROVIDER=anthropic PIE_EVAL_MODEL=<model-id> PIE_EVAL_API_KEY=<key>
eval/run-task.sh eval/tasks/<taskId>.json
\`\`\`
产物在 eval/runs/<taskId>-<stamp>/:task.json / run.json / answer.txt / network.har / meta.json / score.json。
ground-truth pass/fail 看 score.json;agent 自报在 run.json.agentSelfReport(仅观测)。

## status 含义
done/timeout/error/harness-error(运行级) · scored/unsupported/scorer-error(打分级)。
仅 score.json.status=scored 的 run 计入成功率。
```

- [ ] **Step 3: E2E smoke(手动,需 docker + key)**

准备一个真实任务 `eval/tasks/0.json`(从 WebArena-Verified 数据集取一个信息检索类任务,填好 goal/startUrl/evalType/webarenaHosts)。

Run:
```bash
export PIE_EVAL_PROVIDER=anthropic PIE_EVAL_MODEL=<model-id> PIE_EVAL_API_KEY=<key>
eval/run-task.sh eval/tasks/0.json
```
Expected:有头 Chrome 弹出、Pie 自主操作 WebArena 页面、终止后打印 `score.json`。**人工核对**:
- `meta.json.status` = `done`;
- `network.har` 只含 WebArena host、无 `Authorization`/`sk-`;
- `score.json.status` = `scored`,`score` 与你对该任务的预期一致。

若任一不符,按 status 定位(harness-error→启动/SW;scorer-error→契约漂移,回 Task 0)。

- [ ] **Step 4: Commit**

```bash
git add eval/run-task.sh eval/README.md eval/tasks/0.json
git commit -m "feat(eval): glue script + README + first E2E smoke task"
```

---

## Self-Review

**1. Spec coverage(逐节核对 spec → task):**
- §3 三组件 + SW-evaluate 可达 → Task 2(bridge)+ Task 4(orchestrator,`serviceWorker.evaluate`)。✅
- §4.1 MockPort 复用 runAgentLoop / 答案抽取 / dev-only 隔离 / seedConfig → Task 2 + Task 3。✅
- §4.2 orchestrator 时序 / HAR 清洗 / artifact bundle / 强隔离 profile → Task 4(run-task.ts)+ Task 1(scrub)。✅
- §4.3 契约 spike / scorer / 两类任务 → Task 0 + Task 5(含 `SUPPORTS_STATE_CHANGING` 矩阵)。✅
- §5 status 分类 → `RunStatus`(Task 1 types)+ scorer status(Task 5)+ README(Task 6)。✅
- §6 / §8 测试 → har-scrub 单测(T1)、bridge 单测(T2)、build invariant(T3)、scorer golden(T5)、E2E smoke(T6)。✅
- §7 实现顺序 = 本 plan Task 0→6 顺序。✅

**2. Placeholder scan:** 唯一受研究门控的是 Task 5 的 `call_evaluator` 真实调用与 fixtures 的具体答案——已显式绑定到 Task 0 冻结的 `EVALUATOR_CONTRACT.md`,并给出最可能的具体形状 + 对齐指引,非空泛 TODO。其余步骤均含完整代码与确切命令。

**3. Type consistency:** `EvalTrace` 字段(answer/agentSelfReport/steps/usage/startedAt/endedAt/error)在 Task 1 定义、Task 2 产出、Task 4 落盘、Task 5 读取一致;`RunStatus` 在 Task 1 定义、Task 4 使用一致;bridge 方法名(seedConfig/startTask/waitForDone/getTrace/reset)在 Task 2 定义、Task 4 `serviceWorker.evaluate` 调用一致;port 消息类型引用自 `@/types/messages` 的真实导出(AgentDoneTaskMessage/AgentStepMessage/ChatErrorMessage/AgentUsageMessage)。

**已知偏差(对 spec 的合理收窄):** seedConfig v1 只支持 builtin provider(`createInstance` 不收 baseUrl),custom provider/baseUrl 延后——已在 Task 2 代码注释标注。

---

## 风险与回退

- **评估器契约不可行(最大风险)** → Task 0 即暴露;若状态改变类需 live DB,`SUPPORTS_STATE_CHANGING=False`,v1 只收信息检索类。
- **`webarena-verified` 安装失败** → Task 0 Step 1 的 `browsergym-webarena-verified` fallback,差异记契约文档。
- **headful 限制** → 本期仅本地手动 E2E,不进 CI(README 说明);CI 化需 xvfb,后续单列。
- **WebArena docker 搭建成本** → 一次性,按官方 README;非本 plan 代码范围。
