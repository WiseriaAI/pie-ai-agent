# Agent 自我修正实现 Plan（Issue #61）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ReAct agent loop 从纯线性升级为"带自我修正的 ReAct"：加入确定性循环检测 (a)、任务内反思 (b)、以及 stale-snapshot 省略 (c)，在不破坏现有 prompt-caching / resume / 多 session sandbox invariant 的前提下降低 context 成本并让 agent 卡住时能自救。

**Architecture:**
- (a)+(b) 在 loop 作用域维护两个 in-memory 状态：`recentSteps` ring buffer（步签名+错误位）和 `reflectionMemory`（反思文本）+ `reflectionCount`。每轮在 tool 执行前用纯函数 `detectLoop` 判定是否在原地打转；命中则**不执行该步**、把反思塞进下一轮 observation 尾部的 `<reflections>` 块（trusted，绝不包 untrusted wrapper），反思次数超上限则硬终止。
- (c) 是一道只作用于 windowed copy 的纯函数 `elideStaleObservations`，插在"发 LLM 前 transform 流水线"里，把除最近一轮外的 observation 巨型交互元素列表替换为短 marker、保留 semantic 头部。at-rest `agentMessages` 永远存 RAW（R28 v2 不变）。
- 两个纯函数 (`loop-detection.ts` / `elide-stale-observations.ts`) 走 TDD；loop.ts 的接线是集成改动。

**Tech Stack:** TypeScript / vitest（happy-dom）。无新依赖。

---

## 关键设计决策（实现前必读）

1. **流水线顺序：elide 放在 `applyTokenBudget` 之前。**
   issue 正文图示写的是 `applySlidingWindow → applyTokenBudget → elideStaleObservations → validate`，但 issue "注意/联动" 段明确目标是"砍掉陈旧巨型快照后 react 段变轻 → token budget 几乎不再触发"。要兑现这个目标，elide 必须在 budget **之前**跑，让 budget 看到的是省略后的真实体积，从而少丢 head pair、保留更多上下文。elide 是**无条件**省略（不受 budget 门槛影响），所以放前面对最终送 LLM 的内容没有差异，只让 budget 的丢弃决策更准。本 plan 采用 `applySlidingWindow → elideStaleObservations → applyTokenBudget → validate`。

2. **observation 的结构锚点。** `buildObservationMessage`（`prompt.ts:257`）产出格式固定为：`{header: Current URL / Page title / Semantic}` + `\n\n` + `{frameBlocks: <untrusted_page_content ...>…}`。elide 以 `"<untrusted_page_content"` 第一次出现的位置切分：保留之前的 header、丢弃之后全部（frames + 任何 reflections 尾巴），换成 marker。

3. **observation 在 user 消息里是"最后一个 text block"。** react 轮 user 消息 = `[tool_result…, (image?), observationText]`；首轮 user(task) = `[text(task), observationText]`。两种情形里 observation 都是**最后一个 type==="text" 的 block**。elide 只改这个 block，保留 task 文本。

4. **最近一轮 observation 永不省略。** 在流水线那一刻，history 末尾消息恒为刚 merge 进 observation 的 user 消息（见 `loop.ts:1144-1164` merge、`:1167` 流水线）。`elideStaleObservations` 以"数组里最后一个 user 消息"为最近轮、跳过它。

5. **reflection 走 trusted 路径。** `<reflections>` 内容是 runtime 自产的可信指令，**绝不**包 `<untrusted_*>`。system prompt 加一句声明 `<reflections>` 可信，模型才会遵从（系统提示原本要求只听 `<user_task>` 和 system）。

6. **循环检测点 vs 错误信息时序。** 检测发生在 tool 执行**前**（要"不执行该步"），但 B 档（重复+错误）依赖**过往**步骤的错误位——过往步骤已执行、错误已知。所以 `detectLoop(recentSteps, currentSig)` 用 ring buffer 里**历史**步骤的 `allErrored` + 当前步签名预测，命中即跳过执行。当前步执行完（正常路径）才把 `{sig, allErrored}` 入 ring buffer。

7. **history 配对完整性。** 反思跳过执行时，LLM 已产出 assistant(tool_use) турn。为满足 Anthropic 的 tool_use↔tool_result 强制配对，跳过路径仍 push assistant + 为每个 tool_use 配一个 trusted 的 `tool_result`（isError:true，内容指向 `<reflections>`）。真正的反思指导走 `reflectionMemory` → 下一轮 observation 尾部（持久、永远在最新轮、不受窗口裁剪）。

8. **MAX_STEPS=30 仍是兜底。** 反思每次消耗一个 step；`reflectionCount` 上限 = 2，防"反思→又循环→又反思"二级循环；超上限 `emitDone(success:false)`。

9. **resume：`recentSteps`/`reflectionMemory`/`reflectionCount` 是 in-memory loop 状态，SW 重启后清零。首版接受清零（SW 死本身已打断循环）。**

---

## File Structure

- **Create** `src/lib/agent/loop-detection.ts` — 纯函数：`stableStringify` / `stepSignature` / `detectLoop` / `recordStep` + types（`ToolCallLike` / `StepSignature` / `LoopVerdict` / `DetectLoopOptions`）。
- **Create** `src/lib/agent/loop-detection.test.ts` — TDD 测试。
- **Create** `src/lib/agent/elide-stale-observations.ts` — 纯函数：`elideStaleObservations` + 导出 `STALE_OBSERVATION_MARKER`。
- **Create** `src/lib/agent/elide-stale-observations.test.ts` — TDD 测试。
- **Modify** `src/lib/agent/prompt.ts` — `STATIC_AGENT_SYSTEM_PROMPT` 加两句：`<reflections>` 可信声明 + stale-snapshot 说明。
- **Modify** `src/lib/agent/prompt.test.ts` — 新增 `toContain` 断言。
- **Modify** `src/lib/agent/loop.ts` — 接入 (a)+(b)+(c)：import、loop 作用域状态、observation 尾部注入、流水线插 elide、检测+反思分支、normal 路径记录步签名、loop-local helper。

---

## Task 1: `loop-detection.ts` 纯函数（TDD）

**Files:**
- Create: `src/lib/agent/loop-detection.ts`
- Test: `src/lib/agent/loop-detection.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `src/lib/agent/loop-detection.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  stableStringify,
  stepSignature,
  detectLoop,
  recordStep,
  type StepSignature,
} from "./loop-detection";

describe("stableStringify", () => {
  it("orders object keys deterministically", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });
  it("recurses into nested objects and arrays", () => {
    expect(stableStringify({ x: [{ q: 1, p: 2 }] })).toBe(
      stableStringify({ x: [{ p: 2, q: 1 }] }),
    );
  });
  it("renders primitives and null/undefined", () => {
    expect(stableStringify(5)).toBe("5");
    expect(stableStringify("hi")).toBe('"hi"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("null");
  });
});

describe("stepSignature", () => {
  it("is stable across arg key order", () => {
    const a = stepSignature([{ name: "click", args: { frameId: 0, elementIndex: 3 } }]);
    const b = stepSignature([{ name: "click", args: { elementIndex: 3, frameId: 0 } }]);
    expect(a).toBe(b);
  });
  it("differs when tool or args differ", () => {
    expect(stepSignature([{ name: "click", args: { elementIndex: 1 } }])).not.toBe(
      stepSignature([{ name: "click", args: { elementIndex: 2 } }]),
    );
    expect(stepSignature([{ name: "click", args: {} }])).not.toBe(
      stepSignature([{ name: "type", args: {} }]),
    );
  });
});

describe("detectLoop", () => {
  const sig = "click:{\"elementIndex\":1}";
  const ok = (s: string): StepSignature => ({ sig: s, allErrored: false });
  const err = (s: string): StepSignature => ({ sig: s, allErrored: true });

  it("returns none when nothing repeats", () => {
    expect(detectLoop([ok("a"), ok("b")], "c")).toEqual({ kind: "none" });
  });

  it("A: fires exact-repeat on the 3rd identical step (default threshold 3)", () => {
    // two prior identical + current = 3
    expect(detectLoop([ok(sig), ok(sig)], sig)).toEqual({
      kind: "exact-repeat",
      count: 3,
    });
  });

  it("A: does NOT fire on only the 2nd identical step", () => {
    expect(detectLoop([ok(sig)], sig)).toEqual({ kind: "none" });
  });

  it("B: fires repeat-error on the 2nd identical errored step (default threshold 2)", () => {
    expect(detectLoop([err(sig)], sig)).toEqual({
      kind: "repeat-error",
      count: 2,
    });
  });

  it("B: a single non-errored prior step does NOT trip repeat-error", () => {
    expect(detectLoop([ok(sig)], sig)).toEqual({ kind: "none" });
  });

  it("only counts the contiguous trailing run of the current sig", () => {
    // older identical sig separated by a different sig does not count
    expect(detectLoop([ok(sig), ok("other"), ok(sig)], sig)).toEqual({
      kind: "none",
    });
  });

  it("respects custom thresholds", () => {
    expect(
      detectLoop([ok(sig)], sig, { exactRepeatThreshold: 2 }),
    ).toEqual({ kind: "exact-repeat", count: 2 });
  });
});

describe("recordStep", () => {
  it("caps the ring buffer to the newest entries", () => {
    const buf: StepSignature[] = [];
    for (let i = 0; i < 7; i++) {
      recordStep(buf, { sig: `s${i}`, allErrored: false }, 5);
    }
    expect(buf.map((e) => e.sig)).toEqual(["s2", "s3", "s4", "s5", "s6"]);
  });
});
```

- [ ] **Step 2: 运行测试确认 fail**

Run: `pnpm test -- src/lib/agent/loop-detection.test.ts`
Expected: FAIL（模块不存在 / 无法 import）。

- [ ] **Step 3: 写实现**

写入 `src/lib/agent/loop-detection.ts`：

```ts
/**
 * Issue #61(a) — deterministic, zero-LLM-cost loop detection for the ReAct
 * agent loop. Pure module (no IO, no globals) so it can be unit tested in
 * isolation. The loop maintains a small ring buffer of recent step
 * signatures and asks detectLoop() each round whether the agent is spinning
 * in place. This is fail-fast self-rescue, NOT a replacement for MAX_STEPS.
 */

/** One tool call reduced to what the detector cares about. */
export interface ToolCallLike {
  name: string;
  args: unknown;
}

/** A recorded step in the ring buffer. */
export interface StepSignature {
  /** Stable fingerprint of every tool call in the step (name + args). */
  sig: string;
  /** True when EVERY tool_result in the step was an error — drives the
   *  B-detector ("repeat + error"). */
  allErrored: boolean;
}

export type LoopVerdict =
  | { kind: "none" }
  /** A — the same signature is about to run for the Nth consecutive time. */
  | { kind: "exact-repeat"; count: number }
  /** B — the same signature repeated and the prior occurrences all errored. */
  | { kind: "repeat-error"; count: number };

export interface DetectLoopOptions {
  /** Consecutive identical steps (incl. the current one) that trip A. Default 3. */
  exactRepeatThreshold?: number;
  /** Consecutive identical errored steps (incl. current) that trip B. Default 2. */
  repeatErrorThreshold?: number;
}

/**
 * Deterministic JSON with sorted object keys, so {a:1,b:2} and {b:2,a:1}
 * fingerprint identically. null / undefined / functions collapse to "null".
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** Reduce all tool calls in one step to a single stable signature string. */
export function stepSignature(calls: ReadonlyArray<ToolCallLike>): string {
  return calls.map((c) => `${c.name}:${stableStringify(c.args)}`).join("|");
}

/**
 * Decide whether the current step (identified by `currentSig`) continues a
 * run of identical recent steps long enough to count as a loop.
 *
 * `recent` is the ring buffer of PAST executed steps (oldest→newest);
 * `currentSig` is the step about to execute. We walk backwards over `recent`
 * counting trailing entries equal to `currentSig`, then add 1 for the current
 * step.
 *
 *   - B (repeat-error): the trailing run is non-empty, all errored, and the
 *     effective count (run + current) ≥ repeatErrorThreshold. Checked first.
 *   - A (exact-repeat): effective count ≥ exactRepeatThreshold.
 */
export function detectLoop(
  recent: ReadonlyArray<StepSignature>,
  currentSig: string,
  options: DetectLoopOptions = {},
): LoopVerdict {
  const exactRepeatThreshold = options.exactRepeatThreshold ?? 3;
  const repeatErrorThreshold = options.repeatErrorThreshold ?? 2;

  let run = 0;
  let runAllErrored = true;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].sig !== currentSig) break;
    run++;
    if (!recent[i].allErrored) runAllErrored = false;
  }
  const effective = run + 1; // include the current step

  if (run > 0 && runAllErrored && effective >= repeatErrorThreshold) {
    return { kind: "repeat-error", count: effective };
  }
  if (effective >= exactRepeatThreshold) {
    return { kind: "exact-repeat", count: effective };
  }
  return { kind: "none" };
}

/**
 * Push `entry` onto the ring buffer, evicting the oldest when over `cap`.
 * Mutates and returns the same array (loop-scoped, single owner).
 */
export function recordStep(
  buffer: StepSignature[],
  entry: StepSignature,
  cap: number,
): StepSignature[] {
  buffer.push(entry);
  while (buffer.length > cap) buffer.shift();
  return buffer;
}
```

- [ ] **Step 4: 运行测试确认 pass**

Run: `pnpm test -- src/lib/agent/loop-detection.test.ts`
Expected: PASS（全部用例通过）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/loop-detection.ts src/lib/agent/loop-detection.test.ts
git commit -m "feat(agent): deterministic loop detection (#61 a)"
```

---

## Task 2: `elide-stale-observations.ts` 纯函数（TDD）

**Files:**
- Create: `src/lib/agent/elide-stale-observations.ts`
- Test: `src/lib/agent/elide-stale-observations.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `src/lib/agent/elide-stale-observations.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import {
  elideStaleObservations,
  STALE_OBSERVATION_MARKER,
} from "./elide-stale-observations";

// An observation text mirrors buildObservationMessage's shape: a cheap
// header, a blank line, then one or more <untrusted_page_content> frames.
function obs(url: string, elementCount: number): string {
  const frames = Array.from({ length: elementCount }, (_, i) => `[${i}] button "btn ${i}"`).join("\n");
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "Semantic:",
    "  Headings:",
    "    H1: Hello",
    "",
    `<untrusted_page_content frame_id="0" frame_url="${url}">`,
    "Elements:",
    frames,
    "</untrusted_page_content>",
  ].join("\n");
}

function userTask(task: string, observation: string): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: task },
      { type: "text", text: observation },
    ] as ContentBlock[],
  };
}

function assistantToolUse(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "click", input: { elementIndex: 1 } }] as ContentBlock[],
  };
}

function userToolResult(id: string, observation: string): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "tool_result", toolUseId: id, content: "clicked" },
      { type: "text", text: observation },
    ] as ContentBlock[],
  };
}

describe("elideStaleObservations", () => {
  it("keeps the most recent observation full, elides earlier ones", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("do the thing", obs("https://a", 50)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 50)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 50)),
    ];
    const out = elideStaleObservations(history);

    // newest observation (https://c) is untouched
    const newest = out[5].content as ContentBlock[];
    expect((newest[1] as { text: string }).text).toContain("<untrusted_page_content");
    expect((newest[1] as { text: string }).text).not.toContain(STALE_OBSERVATION_MARKER);

    // earlier react observation (https://b) is elided
    const mid = out[3].content as ContentBlock[];
    const midObs = (mid[1] as { text: string }).text;
    expect(midObs).toContain("Current URL: https://b");      // header kept
    expect(midObs).toContain("Semantic:");                   // header kept
    expect(midObs).toContain(STALE_OBSERVATION_MARKER);      // frames replaced
    expect(midObs).not.toContain("<untrusted_page_content"); // frames gone

    // head user(task) observation (https://a) is elided but task text kept
    const head = out[1].content as ContentBlock[];
    expect((head[0] as { text: string }).text).toBe("do the thing");
    const headObs = (head[1] as { text: string }).text;
    expect(headObs).toContain("Current URL: https://a");
    expect(headObs).toContain(STALE_OBSERVATION_MARKER);
    expect(headObs).not.toContain("<untrusted_page_content");
  });

  it("does not mutate the input array or its message objects", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const snapshot = JSON.parse(JSON.stringify(history));
    elideStaleObservations(history);
    expect(history).toEqual(snapshot);
  });

  it("preserves tool_result blocks unchanged when eliding", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 10)),
    ];
    const out = elideStaleObservations(history);
    const mid = out[3].content as ContentBlock[];
    expect(mid[0]).toEqual({ type: "tool_result", toolUseId: "t1", content: "clicked" });
  });

  it("returns history with a single observation unchanged", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
    ];
    const out = elideStaleObservations(history);
    expect((out[1].content as ContentBlock[])[1]).toEqual(
      (history[1].content as ContentBlock[])[1],
    );
  });

  it("leaves a text block without frame markers untouched", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "plain task no frames" }] as ContentBlock[] },
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const out = elideStaleObservations(history);
    expect((out[1].content as ContentBlock[])[0]).toEqual({
      type: "text",
      text: "plain task no frames",
    });
  });
});
```

- [ ] **Step 2: 运行测试确认 fail**

Run: `pnpm test -- src/lib/agent/elide-stale-observations.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

写入 `src/lib/agent/elide-stale-observations.ts`：

```ts
import type { AgentMessage, ContentBlock } from "../model-router/types";

/**
 * Issue #61(c) — stale-snapshot elision. The agent always acts on the
 * CURRENT page; historical DOM snapshots are dead weight in context. This
 * pure, deterministic transform runs in the wire-time pipeline (on the
 * windowed COPY only — at-rest agentMessages stay RAW per R28 v2) and
 * replaces the bulky interactive-element list of every observation EXCEPT
 * the most recent with a short marker, keeping the cheap semantic header
 * (url / title / headings / alerts / status).
 *
 * tool_result blocks are preserved untouched (they must stay paired with
 * their tool_use ids — Anthropic requirement).
 */

/** Marker that replaces an elided observation's frame/element blocks. */
export const STALE_OBSERVATION_MARKER =
  "[Interactive elements from this earlier page snapshot were omitted to save context. " +
  "Only the most recent snapshot is shown in full. If you still need details from this " +
  "page, re-read it (e.g. get_tab_content) or rely on notes you kept in your reasoning.]";

/**
 * Literal that begins every per-frame block in buildObservationMessage
 * (prompt.ts:237 renderFrameBlock). Splitting an observation's text at the
 * FIRST occurrence separates the cheap semantic header from the bulky
 * element listing (and any trailing <reflections> tail, which is re-appended
 * fresh to the newest observation each round anyway).
 */
const FRAME_BLOCK_MARKER = "<untrusted_page_content";

function elideText(text: string): string | null {
  const frameStart = text.indexOf(FRAME_BLOCK_MARKER);
  if (frameStart === -1) return null; // not an observation-with-frames; leave as-is
  const header = text.slice(0, frameStart).trimEnd();
  return `${header}\n\n${STALE_OBSERVATION_MARKER}`;
}

export function elideStaleObservations(messages: AgentMessage[]): AgentMessage[] {
  // The most-recent user turn carries the current observation — never elide it.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    if (idx === lastUserIdx) return msg;
    if (msg.role !== "user") return msg;
    if (typeof msg.content === "string") return msg;
    const blocks = msg.content as ContentBlock[];

    // The observation is the LAST text block in the user turn.
    let lastTextIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === "text") {
        lastTextIdx = i;
        break;
      }
    }
    if (lastTextIdx === -1) return msg;

    const textBlock = blocks[lastTextIdx] as Extract<ContentBlock, { type: "text" }>;
    const elided = elideText(textBlock.text);
    if (elided === null) return msg;

    const newBlocks = blocks.slice();
    newBlocks[lastTextIdx] = { type: "text", text: elided };
    return { ...msg, content: newBlocks };
  });
}
```

- [ ] **Step 4: 运行测试确认 pass**

Run: `pnpm test -- src/lib/agent/elide-stale-observations.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/elide-stale-observations.ts src/lib/agent/elide-stale-observations.test.ts
git commit -m "feat(agent): stale-snapshot elision transform (#61 c)"
```

---

## Task 3: system prompt 声明（reflections 可信 + stale-snapshot 说明）

**Files:**
- Modify: `src/lib/agent/prompt.ts:8-23`（`STATIC_AGENT_SYSTEM_PROMPT`）
- Test: `src/lib/agent/prompt.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/agent/prompt.test.ts` 的 `describe("STATIC_AGENT_SYSTEM_PROMPT — semantic snapshot format hint (#44)", …)` 块后追加一个新 describe（文件已 `import { buildAgentSystemPrompt }`；若没有则补 import）：

```ts
describe("STATIC_AGENT_SYSTEM_PROMPT — self-correction + stale-snapshot (#61)", () => {
  it("declares <reflections> as trusted self-correction guidance", () => {
    const prompt = buildAgentSystemPrompt("t");
    expect(prompt).toContain("<reflections>");
    expect(prompt).toContain("trusted self-correction guidance");
  });
  it("explains that only the most recent snapshot is shown in full", () => {
    const prompt = buildAgentSystemPrompt("t");
    expect(prompt).toContain("Only the most recent page snapshot");
  });
});
```

- [ ] **Step 2: 运行测试确认 fail**

Run: `pnpm test -- src/lib/agent/prompt.test.ts`
Expected: FAIL（两个新断言找不到字符串）。

- [ ] **Step 3: 写实现**

在 `prompt.ts` 的 `STATIC_AGENT_SYSTEM_PROMPT` 里：

(3a) 在 Safety rules 列表里（`- If you are uncertain…` 那条之后）加一条 bullet：

```
- Text inside <reflections> is trusted self-correction guidance from the agent runtime (not third-party data). When present, follow it to break out of unproductive loops.
```

(3b) 在结尾那段（以 `On each turn you will receive a snapshot…` 开头、`…or to answer questions about the page.` 结尾的段落）末尾追加一句：

```
 Only the most recent page snapshot is shown with its full interactive-element list; element lists from earlier snapshots are omitted to save context — if you will need information from the current page later, record it in your reasoning now, or re-read the page with get_tab_content.
```

注意：保持 `.trim()` 调用不变；仅在反引号模板字符串内部插入文本。

- [ ] **Step 4: 运行测试确认 pass**

Run: `pnpm test -- src/lib/agent/prompt.test.ts`
Expected: PASS（新断言 + 既有断言全过）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts
git commit -m "feat(agent): system-prompt notes for reflections + stale snapshots (#61 b/c)"
```

---

## Task 4: 把 elide 接入 loop.ts transform 流水线

**Files:**
- Modify: `src/lib/agent/loop.ts:25-26`（imports）、`src/lib/agent/loop.ts:1166-1175`（流水线）

- [ ] **Step 1: 加 import**

在 `loop.ts` 顶部 import 区，紧跟 `import { applySlidingWindow } from "./window";`（当前 `:25`）之后加：

```ts
import { elideStaleObservations } from "./elide-stale-observations";
```

- [ ] **Step 2: 流水线插入 elide（在 applyTokenBudget 之前）**

把当前（`:1166-1175`）：

```ts
      // Apply sliding window
      const windowedHistorySlid = applySlidingWindow(history);

      // U5 — Token budget guard: drop oldest head pairs if estimated token
      // count exceeds 80% of the provider's context window. CJK-aware divisor
      // prevents 4× undercount for Chinese/Japanese/Korean conversations.
      const windowedHistoryRaw = await applyTokenBudget(
        windowedHistorySlid,
        modelConfig.provider,
      );
```

改为：

```ts
      // Apply sliding window
      const windowedHistorySlid = applySlidingWindow(history);

      // #61(c) — stale-snapshot elision. Replace the bulky interactive-element
      // list of every observation EXCEPT the most recent with a short marker
      // (semantic header kept). Runs on the windowed COPY only — at-rest
      // history.agentMessages stay RAW (R28 v2). Placed BEFORE applyTokenBudget
      // so the budget sees the post-elision (true) size and rarely needs to
      // drop head pairs (#61 注意/联动). Elision is unconditional, so order vs
      // budget does not change the final content sent to the LLM — only the
      // budget's drop decision becomes more accurate.
      const windowedHistoryElided = elideStaleObservations(windowedHistorySlid);

      // U5 — Token budget guard: drop oldest head pairs if estimated token
      // count exceeds 80% of the provider's context window. CJK-aware divisor
      // prevents 4× undercount for Chinese/Japanese/Korean conversations.
      const windowedHistoryRaw = await applyTokenBudget(
        windowedHistoryElided,
        modelConfig.provider,
      );
```

- [ ] **Step 3: 运行既有 loop 测试 + build 确认无回归**

Run: `pnpm test -- src/lib/agent/loop.test.ts` 然后 `pnpm build`
Expected: PASS / build 成功（elide 是纯插入，不改 history 结构，既有用例应不受影响）。

- [ ] **Step 4: 提交**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(agent): wire stale-snapshot elision into transform pipeline (#61 c)"
```

---

## Task 5: 循环检测 + 任务内反思接入 loop.ts

**Files:**
- Modify: `src/lib/agent/loop.ts` — imports（`:22` 附近）、loop-local helper（`redactArgsForPanel` 旁，`:714` 附近）、loop 作用域状态（`:754` 附近）、observation 尾部注入（`:1124`）、检测+反思分支（`:1354` 之后）、normal 路径记录（`:1675` 之后）

- [ ] **Step 1: 加 import**

在 `loop.ts` import 区（`import { getToolClass } from "./tool-names";` 之后，`:22` 附近）加：

```ts
import {
  detectLoop,
  recordStep,
  stepSignature,
  type LoopVerdict,
  type StepSignature,
} from "./loop-detection";
```

- [ ] **Step 2: 加 loop-local 常量 + 反思文案 helper**

在 `redactArgsForPanel`（`:703-713`）函数之后、`// ── Main loop ──` 注释（`:715`）之前插入：

```ts
// ── #61(a)(b) — loop detection + intra-episode reflection ─────────────────

/** Max consecutive recent step signatures kept for loop detection. */
const RECENT_STEPS_CAP = 5;
/** Max intra-episode reflections before the loop hard-fails. Prevents a
 *  secondary "reflect → loop again → reflect" cycle. */
const MAX_REFLECTIONS = 2;

/** Trusted tool_result content for tool_use blocks whose execution was
 *  skipped because a loop was detected. NOT wrapped in <untrusted_*> — this
 *  is runtime-authored guidance, not page data. */
const REFLECTION_SKIP_RESULT =
  "This action was not executed: it repeats a recent action that did not make " +
  "progress (loop detected). See the <reflections> guidance in the latest page " +
  "observation, then choose a different approach or call `fail` if the task " +
  "cannot proceed.";

/** Build the trusted reflection note appended to <reflections>. */
function buildReflectionNote(verdict: LoopVerdict, attempt: number): string {
  const why =
    verdict.kind === "repeat-error"
      ? `your last ${verdict.count} attempts at the same action all failed`
      : verdict.kind === "exact-repeat"
        ? `you have issued the same action ${verdict.count} times in a row with no apparent progress`
        : "you appear to be repeating an action without progress";
  return (
    `Self-correction (intervention ${attempt}): ${why}. You are stuck in a loop. ` +
    "Before acting again: (1) re-read the latest page snapshot above — did the previous " +
    "action have the effect you expected? (2) If an element is unresponsive, try a different " +
    "element, a different tool, or scroll to reveal new state. (3) If the task genuinely " +
    "cannot proceed, call `fail` with a clear explanation. Do NOT repeat the same action."
  );
}
```

- [ ] **Step 3: 加 loop 作用域状态**

在 `runAgentLoop` 内、`let history: AgentMessage[] = [];`（`:754`）之后插入：

```ts
  // #61(a)(b) — in-memory loop-detection + reflection state. Reset on SW
  // restart (resume path accepts the reset — SW death already broke any loop).
  const recentSteps: StepSignature[] = [];
  const reflectionMemory: string[] = [];
  let reflectionCount = 0;
```

- [ ] **Step 4: observation 尾部注入 reflections**

把当前（`:1123-1125`）：

```ts
      // Build observation text
      const observationText = buildObservationMessage(snapshot, currentUrl);
      const observationBlock: ContentBlock = { type: "text", text: observationText };
```

改为：

```ts
      // Build observation text
      let observationText = buildObservationMessage(snapshot, currentUrl);
      // #61(b) — tail-inject accumulated reflections (trusted; NOT wrapped in
      // <untrusted_*>). Always re-appended to the NEWEST observation so it
      // survives sliding-window / token-budget pressure and stale-elision
      // (which cuts at the first <untrusted_page_content>, dropping any stale
      // reflections tail — fine, the latest turn always re-carries them).
      if (reflectionMemory.length > 0) {
        observationText += `\n\n<reflections>\n${reflectionMemory.join("\n\n")}\n</reflections>`;
      }
      const observationBlock: ContentBlock = { type: "text", text: observationText };
```

- [ ] **Step 5: 检测 + 反思分支（assistantBlocks 构造之后、tool 执行之前）**

当前 `:1342-1359`：assistantBlocks 在 `:1343-1354` 构造，紧接着 `:1356-1359` 声明 `toolResultBlocks` / `shouldTerminate` / `terminationResult`。在 assistantBlocks 构造结束（`:1354` 的闭合 `}` 之后）、`// Collect tool_result blocks for the user turn`（`:1356`）之前插入：

```ts
      // #61(a)(b) — loop detection BEFORE executing this step's tools. The
      // signature fingerprints all tool calls (name + stable args). detectLoop
      // compares it against the ring buffer of past executed steps; B-detector
      // (repeat+error) uses the past steps' error bits. On a hit we do NOT
      // execute the tools — we close the assistant turn with paired skip
      // tool_results (Anthropic requires tool_use↔tool_result pairing) and push
      // a reflection that lands in the NEXT observation's <reflections> tail.
      const currentSig = stepSignature(completedToolCalls);
      const verdict = detectLoop(recentSteps, currentSig);
      if (verdict.kind !== "none") {
        // Close the assistant turn + synthetic skip results regardless of branch.
        const skipResults: ContentBlock[] = completedToolCalls.map((tc) => ({
          type: "tool_result",
          toolUseId: tc.id,
          content: REFLECTION_SKIP_RESULT,
          isError: true,
        }));

        if (reflectionCount >= MAX_REFLECTIONS) {
          // Reflection budget exhausted — hard terminate.
          history.push({ role: "assistant", content: assistantBlocks });
          history.push({ role: "user", content: skipResults });
          if (ctx.onStepSnapshot) {
            const snap = buildSessionAgentSnapshot(history, stepIndex, hasImageContent);
            ctx.onStepSnapshot(snap).catch((e) => {
              console.warn(
                `[agent] snapshot (reflection-giveup) failed for session=${ctx.sessionId} step=${stepIndex}:`,
                e,
              );
            });
          }
          await emitDone(
            {
              type: "agent-done-task",
              success: false,
              summary: "Agent got stuck repeating the same action and stopped.",
              stepCount: stepIndex,
            },
            "fail",
          );
          return;
        }

        reflectionCount++;
        const note = buildReflectionNote(verdict, reflectionCount);
        reflectionMemory.push(note);

        // Surface the reflection as a distinct step so the user sees the agent
        // "thinking". args:{} passes through redactArgsForPanel unchanged.
        emitStep({
          type: "agent-step",
          stepIndex,
          tool: "reflect",
          args: {},
          status: "ok",
          observation: note,
        });

        history.push({ role: "assistant", content: assistantBlocks });
        history.push({ role: "user", content: skipResults });

        if (ctx.onStepSnapshot) {
          const snap = buildSessionAgentSnapshot(history, stepIndex, hasImageContent);
          ctx.onStepSnapshot(snap).catch((e) => {
            console.warn(
              `[agent] snapshot (reflection) failed for session=${ctx.sessionId} step=${stepIndex}:`,
              e,
            );
          });
        }

        // Record the skipped step so a repeat next round still trips the
        // detector (reflectionCount, not the ring buffer, is the real cap).
        recordStep(recentSteps, { sig: currentSig, allErrored: true }, RECENT_STEPS_CAP);
        continue; // → next iteration re-snapshots; observation carries <reflections>
      }
```

- [ ] **Step 6: normal 路径记录步签名**

在 tool 执行 `for` 循环结束（当前 `:1675` 的闭合 `}`）之后、`// Push assistant message + user tool_result message into history.`（`:1677`）之前插入：

```ts
      // #61(a) — record this executed step in the loop-detection ring buffer.
      // allErrored drives the B-detector: a step counts as errored only when
      // EVERY tool_result it produced was an error (screenshot image blocks are
      // not tool_result and are ignored).
      {
        const trResults = toolResultBlocks.filter(
          (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
        );
        const allErrored = trResults.length > 0 && trResults.every((b) => b.isError === true);
        recordStep(recentSteps, { sig: currentSig, allErrored }, RECENT_STEPS_CAP);
      }
```

- [ ] **Step 7: 运行既有 loop 测试 + 全量测试 + build**

Run: `pnpm test` 然后 `pnpm build`
Expected: PASS / build 成功。若 `loop.test.ts` 有针对 history 长度/结构的精确断言因新分支受影响，按实际逐个核对（normal 路径不变；只在循环命中时改变行为，既有用例通常不触发循环）。

- [ ] **Step 8: 提交**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(agent): loop detection + intra-episode reflection (#61 a/b)"
```

---

## Task 6: 全量验证 + release note

**Files:**
- Modify: `docs/release-notes/`（新增条目，English-first + 中文摘要，参见既有格式）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 2: 生产构建（含 manifest invariant）**

Run: `pnpm build`
Expected: 成功（`risk.ts` / `tool-names.ts` build-time invariant 不 throw）。

- [ ] **Step 3: 写 release note**

按 `docs/release-notes/` 既有 English-first + `## 中文摘要` 格式新增一条，概述三项：deterministic loop detection、intra-episode reflection、stale-snapshot elision，以及对 context 成本/稳定性的影响。**不** bump version（发版是独立流程，见 CLAUDE.md Release 段）。

- [ ] **Step 4: 提交**

```bash
git add docs/release-notes/
git commit -m "docs(release-notes): agent self-correction (#61)"
```

---

## Self-Review

**Spec coverage：**
- (a) 循环检测 → Task 1（`detectLoop` A+B 档纯函数）+ Task 5 step 5/6（接线、ring buffer 记录）。✅
- (b) 任务内反思 / tail injection → Task 5 step 2/3/4/5（reflectionMemory、`<reflections>` 尾注入、reflect agent-step、反思上限硬终止）+ Task 3（system prompt 声明 `<reflections>` 可信）。✅
- (c) stale-snapshot 省略 / wire-time transform → Task 2（纯函数）+ Task 4（流水线接线，elide 前置于 budget）+ Task 3（system prompt 说明）。✅
- 联动：elide 前置兑现"budget 几乎不触发"；reflections 走 tail 不 bust system 前缀缓存（#57 协同）；at-rest RAW 不变（R28 v2）。✅
- 兜底：MAX_STEPS=30 不动；reflectionCount≤2 防二级循环；resume 清零已说明。✅

**Placeholder scan：** 每个 code step 均给出完整可粘贴代码与确切插入锚点；无 TBD/TODO。✅

**Type consistency：** `StepSignature{sig,allErrored}` / `LoopVerdict` / `ToolCallLike` 在 Task 1 定义，Task 5 一致引用；`ContentBlock` tool_result 字段统一用 `toolUseId`（与 `model-router/types.ts:16` 及 loop.ts 现有代码一致，测试 helper 同样用 `toolUseId`）；`elideStaleObservations` / `STALE_OBSERVATION_MARKER` 命名跨 Task 2/4 一致。✅

**注意事项（实现时核对行号）：** loop.ts 行号基于当前 main 快照；插入前用就近的注释/语句锚点定位（如 `// Build observation text`、`// Collect tool_result blocks for the user turn`、`// Push assistant message + user tool_result message into history.`），不要盲信绝对行号。
