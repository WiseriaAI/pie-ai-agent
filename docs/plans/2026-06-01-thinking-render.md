# 思考过程渲染与回喂 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型的思考过程（OpenAI-compat 的 `reasoning_content`/`reasoning` 字段与 `<think>` 标签、Anthropic-wire 的原生 thinking block）从正文里分离出来，统一用可折叠 UI 渲染并持久化；Anthropic-wire 的 thinking 额外按回放规则回喂 LLM。

**Architecture:** 新增三段式 `thinking-start/delta/end` StreamEvent + `thinking` ContentBlock；两个 core 各自产出（openai-compat `replay:false` 仅展示，anthropic-sdk `replay:true` 回喂）；`loop.ts` 累积思考、投新 port 消息 `thinking-chunk`、在 tool-call 路径前插 thinking block；panel 并行累积 `streamingThinking`，复用折叠组件渲染并持久化到 session。

**Tech Stack:** TypeScript 6, React 19, vitest + happy-dom + @testing-library/react, `@anthropic-ai/sdk`.

参考 spec：`docs/specs/2026-06-01-thinking-render.md`。关联 issue #93。

---

## 前置：worktree 已就绪

本 plan 在 worktree `feat/thinking-render`（分支同名）执行。首次执行前装依赖：

```bash
pnpm install
```

每个 Task 末尾 commit；全部完成后跑全套 `pnpm test` + `pnpm build` + `pnpm exec tsc --noEmit`。

---

## Task 1: StreamEvent 与 ContentBlock 类型扩展

**Files:**
- Modify: `src/lib/model-router/types.ts`

- [ ] **Step 1: 在 `ContentBlock` 联合中加入 thinking block**

在 `types.ts` 的 `ImageBlock` 之后、`ContentBlock` 联合定义之前，新增：

```ts
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Anthropic extended-thinking 回放签名；第三方 anthropic-compat 端点可能不带。 */
  signature?: string;
}
```

把 `ContentBlock` 改为：

```ts
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ThinkingBlock;
```

- [ ] **Step 2: 在 `StreamEvent` 联合中加入三段式 thinking 事件**

把 `StreamEvent` 联合改为追加三个成员（放在 `text-delta` 之后）：

```ts
export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-start"; replay: boolean }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-end"; signature?: string }
  | { type: "tool-call-start"; id: string; index: number; name: string }
  | { type: "tool-call-delta"; index: number; argsDelta: string }
  | { type: "tool-call-end"; index: number }
  | {
      type: "done";
      stopReason?: "end" | "tool_calls" | "length";
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: "error"; error: string };
```

- [ ] **Step 3: 类型检查通过**

Run: `pnpm exec tsc --noEmit 2>&1 | grep "error TS" | grep -v TS5101 || echo OK`
Expected: `OK`（仅预存的 tsconfig baseUrl deprecation 噪音被过滤）

- [ ] **Step 4: Commit**

```bash
git add src/lib/model-router/types.ts
git commit -m "feat(types): add thinking StreamEvents + ThinkingBlock (#93)"
```

---

## Task 2: ThinkTagSplitter（跨 chunk 的 `<think>` 流式拆分器）

**Files:**
- Create: `src/lib/model-router/think-tag-splitter.ts`
- Test: `src/lib/model-router/think-tag-splitter.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/model-router/think-tag-splitter.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createThinkTagSplitter, type ThinkSegment } from "./think-tag-splitter";

function run(chunks: string[]): ThinkSegment[] {
  const s = createThinkTagSplitter();
  const out: ThinkSegment[] = [];
  for (const c of chunks) out.push(...s.feed(c));
  out.push(...s.flush());
  // 合并相邻同类，便于断言
  const merged: ThinkSegment[] = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (last && last.kind === seg.kind) last.text += seg.text;
    else merged.push({ ...seg });
  }
  return merged.filter((m) => m.text.length > 0);
}

describe("createThinkTagSplitter", () => {
  it("passes plain text through untouched", () => {
    expect(run(["hello world"])).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("splits a complete <think>…</think> in one chunk", () => {
    expect(run(["before<think>reason</think>after"])).toEqual([
      { kind: "text", text: "before" },
      { kind: "think", text: "reason" },
      { kind: "text", text: "after" },
    ]);
  });

  it("handles a tag split across chunk boundary (<th|ink>)", () => {
    expect(run(["a<th", "ink>b</think>c"])).toEqual([
      { kind: "text", text: "a" },
      { kind: "think", text: "b" },
      { kind: "text", text: "c" },
    ]);
  });

  it("handles a closing tag split across boundary (</thi|nk>)", () => {
    expect(run(["<think>x</thi", "nk>y"])).toEqual([
      { kind: "think", text: "x" },
      { kind: "text", text: "y" },
    ]);
  });

  it("treats a non-tag '<' as text", () => {
    expect(run(["a < b > c"])).toEqual([{ kind: "text", text: "a < b > c" }]);
  });

  it("emits an unclosed <think> tail as think on flush", () => {
    expect(run(["<think>still thinking"])).toEqual([
      { kind: "think", text: "still thinking" },
    ]);
  });

  it("emits a dangling partial tag at EOF as text", () => {
    expect(run(["hello<thi"])).toEqual([{ kind: "text", text: "hello<thi" }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/lib/model-router/think-tag-splitter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 splitter**

`src/lib/model-router/think-tag-splitter.ts`：

```ts
export interface ThinkSegment {
  kind: "text" | "think";
  text: string;
}

export interface ThinkTagSplitter {
  feed(chunk: string): ThinkSegment[];
  flush(): ThinkSegment[];
}

const OPEN = "<think>";
const CLOSE = "</think>";

/** 返回 s 末尾是否为 tag 的一个真前缀（含从某个 '<' 起算），是则返回该前缀起点 index，否则 -1。 */
function partialTagStart(s: string, tag: string): number {
  const maxLen = Math.min(s.length, tag.length - 1);
  for (let len = maxLen; len >= 1; len--) {
    const tail = s.slice(s.length - len);
    if (tag.startsWith(tail)) return s.length - len;
  }
  return -1;
}

export function createThinkTagSplitter(): ThinkTagSplitter {
  let inside = false;
  let carry = ""; // 可能是被切断的 tag 前缀

  function process(input: string, isFlush: boolean): ThinkSegment[] {
    let buf = carry + input;
    carry = "";
    const out: ThinkSegment[] = [];

    while (buf.length > 0) {
      const tag = inside ? CLOSE : OPEN;
      const idx = buf.indexOf(tag);
      if (idx !== -1) {
        const before = buf.slice(0, idx);
        if (before) out.push({ kind: inside ? "think" : "text", text: before });
        inside = !inside;
        buf = buf.slice(idx + tag.length);
        continue;
      }
      // 无完整 tag。若非 flush，检查末尾是否为被切断的 tag 前缀，留到下次。
      if (!isFlush) {
        const p = partialTagStart(buf, tag);
        if (p !== -1) {
          const emit = buf.slice(0, p);
          if (emit) out.push({ kind: inside ? "think" : "text", text: emit });
          carry = buf.slice(p);
          return out;
        }
      }
      if (buf) out.push({ kind: inside ? "think" : "text", text: buf });
      buf = "";
    }
    return out;
  }

  return {
    feed: (chunk) => process(chunk, false),
    flush: () => {
      const out = process("", true);
      if (carry) {
        out.push({ kind: inside ? "think" : "text", text: carry });
        carry = "";
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/lib/model-router/think-tag-splitter.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/think-tag-splitter.ts src/lib/model-router/think-tag-splitter.test.ts
git commit -m "feat(model-router): streaming <think> tag splitter (#93)"
```

---

## Task 3: openai-compat-core 产出 thinking（reasoning 字段 + `<think>`，replay:false）

**Files:**
- Modify: `src/lib/model-router/providers/_shared/openai-compat-core.ts`
- Test: `src/lib/model-router/providers/_shared/openai-compat-core.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `openai-compat-core.test.ts` 末尾追加（文件已存在；保留原有 import，按需补 `vi`）：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChatOpenAICompat } from "./openai-compat-core";
import type { ModelConfig } from "@/lib/model-router";
import type { StreamEvent } from "@/lib/model-router/types";

function sse(lines: string[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(l));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const cfg = { provider: "openai", model: "m", apiKey: "k", baseUrl: "https://api.openai.com" } as ModelConfig;

async function collect(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("openai-compat thinking", () => {
  it("maps reasoning_content to thinking events (replay:false), not text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking…"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const ev = await collect(streamChatOpenAICompat(cfg, [{ role: "user", content: "hi" }]));
    const types = ev.map((e) => e.type);
    expect(types).toContain("thinking-start");
    expect(ev.find((e) => e.type === "thinking-start")).toMatchObject({ replay: false });
    expect(ev.find((e) => e.type === "thinking-delta")).toMatchObject({ text: "thinking…" });
    expect(ev.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("answer");
    // thinking-end 在正文到达前发出
    const tEnd = types.indexOf("thinking-end");
    const firstText = types.indexOf("text-delta");
    expect(tEnd).toBeGreaterThanOrEqual(0);
    expect(tEnd).toBeLessThan(firstText);
  });

  it("splits inline <think> tags out of content (replay:false)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sse([
        'data: {"choices":[{"delta":{"content":"<think>plan</think>done"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const ev = await collect(streamChatOpenAICompat(cfg, [{ role: "user", content: "hi" }]));
    expect(ev.find((e) => e.type === "thinking-delta")).toMatchObject({ text: "plan" });
    expect(ev.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("done");
  });

  it("leaves plain content unaffected (no thinking events)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sse([
        'data: {"choices":[{"delta":{"content":"hello"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const ev = await collect(streamChatOpenAICompat(cfg, [{ role: "user", content: "hi" }]));
    expect(ev.some((e) => e.type.startsWith("thinking"))).toBe(false);
    expect(ev.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("hello");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/lib/model-router/providers/_shared/openai-compat-core.test.ts`
Expected: FAIL（thinking 事件未产出）

- [ ] **Step 3: 实现**

在 `openai-compat-core.ts` 顶部 import：

```ts
import { createThinkTagSplitter } from "../../think-tag-splitter";
```

在 `streamChatOpenAICompat` 进入 SSE 循环前（`let usage` 附近）加状态：

```ts
const splitter = createThinkTagSplitter();
let thinkingOpen = false;
```

把原第 194 行 `if (delta?.content) yield { type: "text-delta", text: delta.content };` 替换为：

```ts
const reasoning: string | undefined = delta?.reasoning_content ?? delta?.reasoning;
if (reasoning) {
  if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
  yield { type: "thinking-delta", text: reasoning };
}
if (delta?.content) {
  for (const seg of splitter.feed(delta.content)) {
    if (seg.kind === "think") {
      if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
      yield { type: "thinking-delta", text: seg.text };
    } else {
      if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
      yield { type: "text-delta", text: seg.text };
    }
  }
}
```

在**每个**发 `done` 之前先收尾思考与 splitter。提取一个内联序列，插入到三处 done 发射点（`[DONE]` 分支 line ~181/184、`finishReason` 分支 line ~219/222、循环结束后的 fallthrough line ~230）——每处在 `yield { type: "done", ... }` 之前插入：

```ts
for (const seg of splitter.flush()) {
  if (seg.kind === "think") {
    if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
    yield { type: "thinking-delta", text: seg.text };
  } else {
    if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
    yield { type: "text-delta", text: seg.text };
  }
}
if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
```

> 注：`splitter.flush()` 第二次调用应是幂等空结果，但三处 done 是互斥提前 return 的，只会命中其一，故安全。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/lib/model-router/providers/_shared/openai-compat-core.test.ts`
Expected: PASS（新增 3 用例 + 原有用例全过）

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/_shared/openai-compat-core.ts src/lib/model-router/providers/_shared/openai-compat-core.test.ts
git commit -m "feat(openai-compat): extract reasoning_content + <think> as thinking events (#93)"
```

---

## Task 4: anthropic-sdk-core 产出 thinking（replay:true）+ 回传序列化

**Files:**
- Modify: `src/lib/model-router/providers/_shared/anthropic-sdk-core.ts`
- Test: `src/lib/model-router/providers/_shared/anthropic-sdk-core.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `anthropic-sdk-core.test.ts` 追加（复用文件已有的 `sse` / `config` / `collect` helper）：

```ts
const THINKING_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG=="}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

describe("anthropic-sdk thinking", () => {
  it("maps thinking blocks to thinking events (replay:true) with signature", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(THINKING_STREAM));
    const ev = await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    expect(ev.find((e) => e.type === "thinking-start")).toMatchObject({ replay: true });
    expect(ev.find((e) => e.type === "thinking-delta")).toMatchObject({ text: "let me think" });
    expect(ev.find((e) => e.type === "thinking-end")).toMatchObject({ signature: "SIG==" });
    expect(ev.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("answer");
  });

  it("serializes a thinking ContentBlock back onto the wire, first in content", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(["event: message_stop\ndata: {}\n\n"]));
    await collect(
      streamChatAnthropicSdk(
        config(),
        [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "prior", signature: "S1" },
              { type: "text", text: "ok" },
            ],
          },
          { role: "user", content: "next" },
        ],
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0].content[0]).toEqual({ type: "thinking", thinking: "prior", signature: "S1" });
    expect(body.messages[0].content[1]).toEqual({ type: "text", text: "ok" });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/lib/model-router/providers/_shared/anthropic-sdk-core.test.ts`
Expected: FAIL（thinking 事件未产出 / thinking block 未序列化）

- [ ] **Step 3a: 在 `toSdkParams` 的 block map 里处理 thinking**

在 `anthropic-sdk-core.ts` 的 `toSdkParams` 内、`block.type === "tool_use"` 分支后、`return { type: "text", ... }` 之前加：

```ts
if (block.type === "thinking") {
  return {
    type: "thinking" as const,
    thinking: block.thinking,
    ...(block.signature ? { signature: block.signature } : {}),
  };
}
```

- [ ] **Step 3b: 在流事件循环里处理 thinking 块**

在 `streamChatAnthropicSdk` 的事件循环前加签名累积器：

```ts
const thinkingSignatures = new Map<number, string>();
```

在 `content_block_start` 处理里（与 `tool_use` 并列）加：

```ts
} else if (event.content_block.type === "thinking") {
  thinkingSignatures.set(event.index, "");
  yield { type: "thinking-start", replay: true };
}
```

在 `content_block_delta` 处理里加（与 `text_delta` / `input_json_delta` 并列）：

```ts
} else if (event.delta.type === "thinking_delta") {
  yield { type: "thinking-delta", text: event.delta.thinking };
} else if (event.delta.type === "signature_delta") {
  const prev = thinkingSignatures.get(event.index) ?? "";
  thinkingSignatures.set(event.index, prev + event.delta.signature);
}
```

在 `content_block_stop` 处理里，于 `toolBlocks` 判断之外加：

```ts
} else if (thinkingSignatures.has(event.index)) {
  const sig = thinkingSignatures.get(event.index)!;
  yield { type: "thinking-end", ...(sig ? { signature: sig } : {}) };
  thinkingSignatures.delete(event.index);
}
```

> SDK 事件类型：`event.delta` 是受 `.type` 收窄的联合，`thinking_delta` 带 `.thinking`，`signature_delta` 带 `.signature`，`content_block.type === "thinking"` 合法。若 TS 报联合不含某成员，用 `(event.delta as any)` 局部断言并加注释。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test src/lib/model-router/providers/_shared/anthropic-sdk-core.test.ts`
Expected: PASS（新增 2 用例 + 原有全过）

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/_shared/anthropic-sdk-core.ts src/lib/model-router/providers/_shared/anthropic-sdk-core.test.ts
git commit -m "feat(anthropic-sdk): emit + replay native thinking blocks (#93)"
```

---

## Task 5: loop.ts 消费 thinking（累积 + 投 thinking-chunk + 前插回喂）

**Files:**
- Create: `src/lib/agent/assistant-blocks.ts`
- Test: `src/lib/agent/assistant-blocks.test.ts`
- Modify: `src/lib/agent/loop.ts`

- [ ] **Step 1: 写 assemble helper 的失败测试**

`src/lib/agent/assistant-blocks.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { assembleAssistantBlocks } from "./assistant-blocks";

describe("assembleAssistantBlocks", () => {
  it("prepends thinking blocks before text and tool_use", () => {
    const blocks = assembleAssistantBlocks(
      [{ type: "thinking", thinking: "why", signature: "S" }],
      "hello",
      [{ id: "t1", name: "click", args: { x: 1 } }],
    );
    expect(blocks).toEqual([
      { type: "thinking", thinking: "why", signature: "S" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "click", input: { x: 1 } },
    ]);
  });

  it("omits the text block when text is empty", () => {
    const blocks = assembleAssistantBlocks([], "", [{ id: "t1", name: "x", args: {} }]);
    expect(blocks).toEqual([{ type: "tool_use", id: "t1", name: "x", input: {} }]);
  });

  it("supports thinking-only (no text, no tools)", () => {
    expect(assembleAssistantBlocks([{ type: "thinking", thinking: "t" }], "", [])).toEqual([
      { type: "thinking", thinking: "t" },
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/lib/agent/assistant-blocks.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 helper**

`src/lib/agent/assistant-blocks.ts`：

```ts
import type { ContentBlock } from "@/lib/model-router/types";

export type ThinkingContentBlock = Extract<ContentBlock, { type: "thinking" }>;
export interface CompletedToolCall { id: string; name: string; args: unknown; }

/** assistant 轮次内容块组装：thinking（前插，Anthropic 要求） → text → tool_use。 */
export function assembleAssistantBlocks(
  thinkingBlocks: ThinkingContentBlock[],
  text: string,
  toolCalls: CompletedToolCall[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const tb of thinkingBlocks) blocks.push(tb);
  if (text) blocks.push({ type: "text", text });
  for (const tc of toolCalls) {
    blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
  }
  return blocks;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test src/lib/agent/assistant-blocks.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: 接入 loop.ts**

在 `loop.ts` 顶部 import：

```ts
import { assembleAssistantBlocks, type ThinkingContentBlock } from "./assistant-blocks";
```

在 `let accumulatedText = "";`（约 line 1462）之后加 thinking 累积态：

```ts
let thinkingAccum = "";
let thinkingReplay = false;
const thinkingBlocks: ThinkingContentBlock[] = [];
```

在事件 `if/else if` 链里，于 `text-delta` 分支之后加三段处理：

```ts
} else if (event.type === "thinking-start") {
  thinkingAccum = "";
  thinkingReplay = event.replay;
} else if (event.type === "thinking-delta") {
  thinkingAccum += event.text;
  port.postMessage(withSession({ type: "thinking-chunk", text: event.text }, sessionId));
} else if (event.type === "thinking-end") {
  if (thinkingReplay && thinkingAccum) {
    thinkingBlocks.push({
      type: "thinking",
      thinking: thinkingAccum,
      ...(event.signature ? { signature: event.signature } : {}),
    });
  }
  thinkingAccum = "";
```

把 line 1645-1656 的 assistant 内容组装（`const assistantBlocks: ContentBlock[] = []; if (accumulatedText)…; for (const tc …)…`）整段替换为：

```ts
const assistantBlocks: ContentBlock[] = assembleAssistantBlocks(
  thinkingBlocks,
  accumulatedText,
  completedToolCalls,
);
```

> pure-text 路径（line 1613 提前 return）不构建 assistantBlocks，故其 thinking 天然仅展示（已通过 thinking-chunk 投给 panel），不回喂——符合设计。

- [ ] **Step 6: 全量回归 + 类型检查**

Run: `pnpm test src/lib/agent && pnpm exec tsc --noEmit 2>&1 | grep "error TS" | grep -v TS5101 || echo OK`
Expected: agent 测试全过；类型 `OK`

> 注：`thinking-chunk` 端口消息类型在 Task 6 加入；本步先用到它，Task 6 前 `tsc` 可能报 `thinking-chunk` 不在 `PortMessageToPanel` 联合。**调整顺序**：先做 Task 6 的类型加项再回到本步类型检查；或本步仅跑 `pnpm test src/lib/agent/assistant-blocks.test.ts`，把整体 `tsc` 留到 Task 6 之后。执行时按此处理。

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent/assistant-blocks.ts src/lib/agent/assistant-blocks.test.ts src/lib/agent/loop.ts
git commit -m "feat(loop): accumulate thinking, post thinking-chunk, replay thinking blocks (#93)"
```

---

## Task 6: Port 消息 + DisplayMessage + Slot 字段

**Files:**
- Modify: `src/types/messages.ts`
- Modify: `src/sidepanel/hooks/useSession/runtime-map.ts`

- [ ] **Step 1: 新增 `ThinkingChunkMessage` 并入 `PortMessageToPanel`**

在 `messages.ts` 的 `ChatChunkMessage` 之后加：

```ts
/** SW → Panel：思考过程增量（与 chat-chunk 并行；面板累积到 streamingThinking）。 #93 */
export interface ThinkingChunkMessage {
  type: "thinking-chunk";
  text: string;
  sessionId: string;
}
```

把 `export type PortMessageToPanel =`（line ~512）联合追加一行（紧跟 `| ChatChunkMessage`）：

```ts
  | ThinkingChunkMessage
```

- [ ] **Step 2: `DisplayMessage` assistant 变体加 `thinking?`**

把 line 208 的 `| { role: "assistant"; content: string }` 改为：

```ts
  | { role: "assistant"; content: string; thinking?: string }
```

- [ ] **Step 3: Slot 加 `streamingThinking`**

在 `runtime-map.ts` 的 `SessionRuntimeSlot` 内（`accumulated` 字段附近）加：

```ts
  /** #93 — 思考过程增量累积器（与 accumulated 并行）。flush 时落到 assistant 消息的 thinking 字段。 */
  streamingThinking: string;
```

在 `EMPTY_SLOT` 里加：

```ts
  streamingThinking: "",
```

- [ ] **Step 4: 类型检查**

Run: `pnpm exec tsc --noEmit 2>&1 | grep "error TS" | grep -v TS5101 || echo OK`
Expected: `OK`（此时 Task 5 用到的 `thinking-chunk` 已在联合中）

- [ ] **Step 5: Commit**

```bash
git add src/types/messages.ts src/sidepanel/hooks/useSession/runtime-map.ts
git commit -m "feat(types): thinking-chunk port msg + DisplayMessage.thinking + slot field (#93)"
```

---

## Task 7: port-handlers 累积思考并在 flush 点附加

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Test: `src/sidepanel/hooks/useSession/port-handlers.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

参考 `port-handlers.test.ts` 既有 harness（构造 deps、调 `handleMessage`、断言 slot）。追加：

```ts
it("accumulates thinking-chunk and attaches it on chat-done", () => {
  const h = makeHandlers(); // 复用文件内既有的 harness 工厂（与现有用例一致）
  const sid = "s1";
  h.handleMessage({ type: "thinking-chunk", text: "reason ", sessionId: sid });
  h.handleMessage({ type: "thinking-chunk", text: "more", sessionId: sid });
  h.handleMessage({ type: "chat-chunk", text: "answer", sessionId: sid });
  h.handleMessage({ type: "chat-done", sessionId: sid });
  const msgs = h.slotsRef.current.get(sid)!.messages;
  const last = msgs[msgs.length - 1];
  expect(last).toMatchObject({ role: "assistant", content: "answer", thinking: "reason more" });
  expect(h.slotsRef.current.get(sid)!.streamingThinking).toBe("");
});

it("flushes a thinking-only assistant message before an agent-step", () => {
  const h = makeHandlers();
  const sid = "s2";
  h.handleMessage({ type: "thinking-chunk", text: "deciding", sessionId: sid });
  h.handleMessage({
    type: "agent-step", sessionId: sid, stepIndex: 0, tool: "click",
    args: {}, status: "pending",
  } as any);
  const msgs = h.slotsRef.current.get(sid)!.messages;
  expect(msgs[0]).toMatchObject({ role: "assistant", content: "", thinking: "deciding" });
  expect(msgs[1]).toMatchObject({ role: "agent-step", tool: "click" });
});
```

> 若文件内还没有 `makeHandlers` 工厂，按既有用例的 deps 构造方式内联（`slotsRef`/`setSlots`/`persistMessages` 用最小 stub；`slotsRef = { current: new Map() }`，`setSlots = (m)=>{slotsRef.current=m}`，`persistMessages = async()=>{}`），并返回 `{ handleMessage, slotsRef }`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `handleMessage` 内、`chat-chunk` 分支之后加 thinking-chunk 分支：

```ts
if (msg.type === "thinking-chunk") {
  patchSlot(id, (prev) => ({ streamingThinking: prev.streamingThinking + msg.text }));
  return;
}
```

定义一个内联组装函数（在 `handleMessage` 闭包内复用），把"累积文本 + 思考 → assistant 消息"统一：

```ts
const buildAssistant = (
  base: DisplayMessage[],
  accumulated: string,
  thinking: string,
): { next: DisplayMessage[]; flushed: boolean } => {
  if (!accumulated.trim() && !thinking.trim()) return { next: base, flushed: false };
  const m: DisplayMessage = {
    role: "assistant",
    content: accumulated,
    ...(thinking.trim() ? { thinking } : {}),
  };
  return { next: [...base, m], flushed: true };
};
```

把 **chat-done** 分支改为：

```ts
if (msg.type === "chat-done") {
  const prev = slotsRef.current.get(id);
  const accumulated = prev?.accumulated ?? "";
  const thinking = prev?.streamingThinking ?? "";
  const baseMessages = prev?.messages ?? [];
  const { next } = buildAssistant(baseMessages, accumulated, thinking);
  patchSlot(id, {
    messages: next,
    accumulated: "",
    streamingThinking: "",
    streamingText: "",
    streaming: false,
    streamFinished: true,
  });
  void persistMessages(id, next);
  return;
}
```

把 **chat-error** 分支同样改用 `buildAssistant`（携带 thinking + 重置 `streamingThinking: ""`）：

```ts
if (msg.type === "chat-error") {
  const prev = slotsRef.current.get(id);
  const accumulated = prev?.accumulated ?? "";
  const thinking = prev?.streamingThinking ?? "";
  const baseMessages = prev?.messages ?? [];
  const { next } = buildAssistant(baseMessages, accumulated, thinking);
  patchSlot(id, {
    error: msg.error,
    messages: next,
    accumulated: "",
    streamingThinking: "",
    streamingText: "",
    streaming: false,
    streamFinished: true,
  });
  void persistMessages(id, next);
  return;
}
```

把 **agent-step** 分支的 flush 段（line 124-132）改为用 `buildAssistant`，并重置 thinking：

```ts
  const thinking = prev?.streamingThinking ?? "";
  const { next: flushedMsgs, flushed } = buildAssistant(baseMessages, accumulated, thinking);
  let nextMessages: DisplayMessage[] = flushedMsgs;
```

并把末尾 `patchSlot(id, { messages: nextMessages, ...(flushed ? { accumulated:"", streamingText:"" } : {}) })` 改为：

```ts
  patchSlot(id, {
    messages: nextMessages,
    ...(flushed ? { accumulated: "", streamingText: "", streamingThinking: "" } : {}),
  });
```

把 **makeDisconnectHandler** 的 flush 改用 `buildAssistant`（注意它在 `handleMessage` 外，需把 `buildAssistant` 提到 `createPortHandlers` 顶层或复制等价逻辑）。最简：在 `makeDisconnectHandler` 内联：

```ts
const thinking = slot.streamingThinking;
const next: DisplayMessage[] =
  slot.accumulated.trim() || thinking.trim()
    ? [...slot.messages, { role: "assistant", content: slot.accumulated, ...(thinking.trim() ? { thinking } : {}) }]
    : slot.messages;
patchSlot(sessionId, {
  messages: next,
  accumulated: "",
  streamingThinking: "",
  streamingText: "",
  streaming: false,
  streamFinished: true,
});
```

> 把 `buildAssistant` 定义提到 `createPortHandlers` 顶层（`patchSlot` 之后、`handleMessage` 之前），这样 `makeDisconnectHandler` 也能用，DRY。届时 disconnect 内直接 `buildAssistant(slot.messages, slot.accumulated, slot.streamingThinking)`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS（新增 2 用例 + 原有全过）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): accumulate streamingThinking, attach on all flush points (#93)"
```

---

## Task 8: ThinkingSection 组件 + MessageBubble/流式接线 + i18n + 暴露 streamingThinking

**Files:**
- Create: `src/sidepanel/components/ThinkingSection.tsx`
- Test: `src/sidepanel/components/ThinkingSection.test.tsx`
- Modify: `src/sidepanel/components/Chat.tsx`
- Modify: `src/sidepanel/hooks/useSession/index.ts`
- Modify: `src/lib/i18n/dictionaries/en.ts`, `src/lib/i18n/dictionaries/zh-CN.ts`

- [ ] **Step 1: i18n 文案**

`zh-CN.ts` 的 `agentStepGroup` 块之后加：

```ts
  thinking: {
    label: "思考过程",
    inProgress: "思考中…",
  },
```

`en.ts` 对应加：

```ts
  thinking: {
    label: "Thinking",
    inProgress: "Thinking…",
  },
```

- [ ] **Step 2: 写组件失败测试**

`src/sidepanel/components/ThinkingSection.test.tsx`：

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ThinkingSection from "./ThinkingSection";

describe("ThinkingSection", () => {
  it("renders collapsed by default; thinking text hidden until expanded", () => {
    render(<ThinkingSection thinking="secret reasoning" streaming={false} />);
    expect(screen.queryByText("secret reasoning")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("secret reasoning")).toBeTruthy();
  });

  it("renders nothing when thinking is empty and not streaming", () => {
    const { container } = render(<ThinkingSection thinking="" streaming={false} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm test src/sidepanel/components/ThinkingSection.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 4: 实现 ThinkingSection**

`src/sidepanel/components/ThinkingSection.tsx`（复用 AgentStepGroup 的折叠样式）：

```tsx
import { useState } from "react";
import { useT } from "@/lib/i18n";
import MarkdownContent from "./Markdown";

interface ThinkingSectionProps {
  thinking: string;
  /** 流式进行中：显示"思考中…"而非"思考过程"。 */
  streaming: boolean;
}

export default function ThinkingSection({ thinking, streaming }: ThinkingSectionProps) {
  const [open, setOpen] = useState(false);
  const t = useT();
  if (!thinking && !streaming) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3 hover:text-fg-2"
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ›
        </span>
        <span>{streaming ? t("thinking.inProgress") : t("thinking.label")}</span>
      </button>
      {open && thinking && (
        <div className="ml-3 border-l border-line pl-2.5 text-[12px] leading-5 text-fg-2">
          <MarkdownContent content={thinking} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test src/sidepanel/components/ThinkingSection.test.tsx`
Expected: PASS（2 用例）

- [ ] **Step 6: MessageBubble 渲染 thinking + 流式接线**

在 `Chat.tsx` 顶部 import：

```ts
import ThinkingSection from "./ThinkingSection";
```

把 `MessageBubble` 的 assistant 分支（line 1611-1621）改为在正文前渲染 thinking。先给 MessageBubble 加可选 prop `thinkingStreaming?: boolean`（找到 `function MessageBubble({ message })` 签名，改为 `function MessageBubble({ message, thinkingStreaming = false }: { message: DisplayMessage; thinkingStreaming?: boolean })`），assistant 分支返回值改为：

```tsx
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="h-1 w-1 rounded-full bg-accent" />
        <span className="caps text-fg-2">{t("chat.agent")}</span>
      </div>
      {(message.role === "assistant" && (message.thinking || thinkingStreaming)) && (
        <ThinkingSection thinking={message.thinking ?? ""} streaming={thinkingStreaming} />
      )}
      {message.content && (
        <div className="text-[13px] leading-5 text-fg-1">
          <MarkdownContent content={message.content} />
        </div>
      )}
    </div>
  );
```

把流式渲染块（line 1173-1185）改为也在仅有思考时渲染，并传 streamingThinking：

```tsx
{streaming && (streamingText || streamingThinking) && (
  <MessageBubble
    message={{ role: "assistant", content: streamingText, thinking: streamingThinking }}
    thinkingStreaming={!!streamingThinking}
  />
)}
{streaming && !streamingText && !streamingThinking && <WorkingIndicator />}
```

在 Chat 组件解构 session 的那段（line 156 附近，`streamingText,`旁）加：

```ts
    streamingThinking,
```

- [ ] **Step 7: 暴露 `streamingThinking` 到 UseSession 公共视图**

在 `useSession/index.ts`：
- 接口（line 173 `streamingText: string;` 旁）加 `streamingThinking: string;`
- 映射（line 1024 `streamingText: active.streamingText,` 旁）加 `streamingThinking: active.streamingThinking,`
- 两处默认视图（line 610、914 的 `streamingText: "",` 旁）各加 `streamingThinking: "",`

- [ ] **Step 8: 全量验证**

Run: `pnpm test && pnpm exec tsc --noEmit 2>&1 | grep "error TS" | grep -v TS5101 || echo OK`
Expected: 全套测试 PASS；类型 `OK`

- [ ] **Step 9: Commit**

```bash
git add src/sidepanel/components/ThinkingSection.tsx src/sidepanel/components/ThinkingSection.test.tsx src/sidepanel/components/Chat.tsx src/sidepanel/hooks/useSession/index.ts src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "feat(panel): ThinkingSection collapsible render + streaming wiring (#93)"
```

---

## Task 9: 全量验证 + 构建 + 手测清单

- [ ] **Step 1: 全套测试 + 构建 + 类型**

```bash
pnpm test
pnpm build
pnpm exec tsc --noEmit 2>&1 | grep "error TS" | grep -v TS5101 || echo OK
```
Expected: 测试全过；build ✓；类型 `OK`

- [ ] **Step 2: 手测（load unpacked `dist/`）**

逐项确认（自动化覆盖不到真实流式/UI）：

1. **OpenAI-compat（reasoning 字段）**：配一个会吐 `reasoning_content` 的 OpenAI-compat 模型（如某 OpenRouter reasoning 路由），跑一轮 → 思考进折叠块、正文不含思考；折叠默认收起、可展开。
2. **OpenAI-compat（`<think>`）**：配一个把 `<think>…</think>` 内联进 content 的模型 → 标签被剥离、思考单独渲染、正文干净（验证 #93 已修）。
3. **Anthropic-wire（minimax M3 / deepseek）**：选会吐 thinking 的模型跑一轮带 tool call 的任务 → 思考渲染；多步任务不报错（thinking block 回放被接受）。
4. **持久化**：有思考的会话刷新 side panel → 思考折叠块仍在。
5. **思考后直接调工具（无正文）**：确认仍渲染出思考折叠块在 step 之前。
6. **回归**：纯文本无思考的普通对话渲染不变；abort 中断干净。

- [ ] **Step 3: 推送 + 开 PR**

```bash
git push -u origin feat/thinking-render
gh pr create --repo WiseriaAI/pie-ai-agent --base main --head feat/thinking-render \
  --title "feat: 思考过程渲染与回喂 (#93)" --body "见 docs/specs/2026-06-01-thinking-render.md 与 docs/plans/2026-06-01-thinking-render.md"
```

---

## Self-Review 记录

- **Spec 覆盖**：reasoning 字段(Task3) / `<think>`(Task2+3) / anthropic thinking(Task4) / 回喂前插(Task5) / port+IR(Task6) / 累积+flush(Task7) / 折叠渲染+持久化+流式(Task8) / 手测(Task9) — 全覆盖。
- **类型一致**：`thinking-start{replay}` / `thinking-delta{text}` / `thinking-end{signature?}`、`ThinkingBlock{thinking,signature?}`、`ThinkingChunkMessage`、`DisplayMessage.thinking?`、`streamingThinking`、`assembleAssistantBlocks` 在各 Task 间一致。
- **顺序依赖**：Task5 用到 `thinking-chunk`（Task6 定义）→ 已在 Task5 Step6 标注先做 Task6 类型项再整体 tsc。执行顺序建议：T1→T2→T3→T4→T6→T5→T7→T8→T9（把 T6 提到 T5 前更顺）。
