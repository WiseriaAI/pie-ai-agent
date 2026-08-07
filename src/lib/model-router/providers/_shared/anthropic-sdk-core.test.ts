import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChatAnthropicSdk } from "./anthropic-sdk-core";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "../../types";

// Build a minimal but complete Anthropic SSE stream covering text + one tool call.
function sse(events: string[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(new TextEncoder().encode(e));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const TEXT_THEN_TOOL = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"click","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

// MiMo / MiniMax report input_tokens late: message_start carries 0, the real
// prompt count only arrives in the terminal message_delta (verified on real
// wire, #59). Anthropic-official instead fills it in message_start.
const LATE_INPUT_TOKENS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":9582,"output_tokens":61}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const LEAKED_TEXT_TOOL_INVOCATION = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<tool_invocation name=\\"read_page\\" arguments={\\"tabId\\": 736359264, \\"mode\\": \\"content\\"} />"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const config = (over: Partial<ModelConfig> = {}): ModelConfig =>
  ({ provider: "anthropic", model: "claude-x", apiKey: "sk-test", baseUrl: "https://api.anthropic.com", ...over }) as ModelConfig;

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("anthropic-sdk-core", () => {
  it("maps SDK stream events → StreamEvent IR (text + tool call)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
    const events = await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "text-delta",
      "tool-call-start",
      "tool-call-delta",
      "tool-call-end",
      "done",
    ]);
    const text = events.find((e) => e.type === "text-delta");
    expect(text).toMatchObject({ text: "hello" });
    const start = events.find((e) => e.type === "tool-call-start");
    expect(start).toMatchObject({ id: "tu_1", name: "click", index: 1 });
    const done = events.find((e) => e.type === "done");
    // input_tokens from message_start (7) must survive a message_delta that omits it.
    expect(done).toMatchObject({ stopReason: "tool_calls", usage: { inputTokens: 7, outputTokens: 12 } });
  });

  it("captures input_tokens reported late in message_delta (MiMo/MiniMax wire)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(LATE_INPUT_TOKENS));
    const events = await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ usage: { inputTokens: 9582, outputTokens: 61 } });
  });

  it("normalizes leaked <tool_invocation /> text into tool-call events", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(LEAKED_TEXT_TOOL_INVOCATION));
    const events = await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    expect(events.map((e) => e.type)).toEqual([
      "tool-call-start",
      "tool-call-delta",
      "tool-call-end",
      "done",
    ]);
    expect(events.find((e) => e.type === "tool-call-start")).toMatchObject({
      name: "read_page",
      index: 0,
    });
    expect(events.find((e) => e.type === "tool-call-delta")).toMatchObject({
      index: 0,
      argsDelta: '{"tabId":736359264,"mode":"content"}',
    });
    expect(events.find((e) => e.type === "done")).toMatchObject({
      stopReason: "tool_calls",
    });
  });

  it("survives an MV3-service-worker-like env with no process / Buffer globals", async () => {
    const origProcess = globalThis.process;
    const origBuffer = (globalThis as Record<string, unknown>).Buffer;
    (globalThis as Record<string, unknown>).process = undefined;
    (globalThis as Record<string, unknown>).Buffer = undefined;
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
      // Constructing the client + building request headers (platform detection)
      // must not throw on the missing globals.
      const events = await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
      expect(events.map((e) => e.type)).toContain("done");
      expect(events.map((e) => e.type)).not.toContain("error");
    } finally {
      (globalThis as Record<string, unknown>).process = origProcess;
      (globalThis as Record<string, unknown>).Buffer = origBuffer;
    }
  });

  it("captures prompt-cache counters from message_start usage", async () => {
    const CACHE_USAGE = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":100,"output_tokens":0,"cache_read_input_tokens":800,"cache_creation_input_tokens":50}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(CACHE_USAGE));
    const events = await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    const done = events.find((e) => e.type === "done");
    // Anthropic's input_tokens excludes cached portions → denominator is the
    // full sum: 100 + 800 + 50 = 950.
    expect(done).toMatchObject({
      usage: {
        inputTokens: 100,
        outputTokens: 12,
        cachedTokens: 800,
        promptTotalTokens: 950,
      },
    });
  });

  it("omits cache fields when no cache activity is reported", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
    const events = await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" ? done.usage : undefined).toEqual({
      inputTokens: 7,
      outputTokens: 12,
    });
  });

  it("apiKey auth → x-api-key header, default base path", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
    await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }], undefined, undefined, { auth: "apiKey" }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("x-api-key")).toBe("sk-test");
    expect(h.get("authorization")).toBeNull();
  });

  it("bearer auth + baseUrlSuffix + stripAnthropicVersion", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
    await collect(
      streamChatAnthropicSdk(
        config({ baseUrl: "https://token-plan-cn.xiaomimimo.com", apiKey: "mk" }),
        [{ role: "user", content: "hi" }],
        undefined,
        undefined,
        { auth: "bearer", baseUrlSuffix: "/anthropic", stripAnthropicVersion: true },
      ),
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("authorization")).toBe("Bearer mk");
    expect(h.get("x-api-key")).toBeNull();
    expect(h.get("anthropic-version")).toBeNull();
  });

  it("promptCache adds cache_control to system + last tool", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
    const tools: ToolDefinition[] = [
      { name: "a", description: "a", parameters: { type: "object" } },
      { name: "b", description: "b", parameters: { type: "object" } },
    ];
    await collect(
      streamChatAnthropicSdk(
        config(),
        [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
        undefined,
        tools,
        { promptCache: true },
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  // --- messages 上的滚动 cache breakpoint ---------------------------------
  //
  // 这几条锁的是「历史也要被缓存」这件事。此前 cache_control 只打 system+tools，
  // 于是长任务里 70%+ 的 token（历史）每轮全价 prefill —— 实测 prompt 102244 中
  // hist 75953，而 cached 恒为 18048。

  /** 造一段 ReAct 历史：head(user) + N 对 (assistant tool_use, user tool_result)。 */
  const reactHistory = (pairs: number): AgentMessage[] => {
    const h: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
    ];
    for (let i = 0; i < pairs; i++) {
      h.push(
        { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "read_page", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: `obs ${i}` }] },
      );
    }
    return h;
  };

  const bodyOf = (fetchMock: ReturnType<typeof vi.spyOn>) =>
    JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);

  const breakpointIndices = (body: { messages: Array<{ content: unknown }> }): number[] =>
    body.messages
      .map((m, i) =>
        Array.isArray(m.content) && m.content.some((b: { cache_control?: unknown }) => b.cache_control)
          ? i
          : -1,
      )
      .filter((i) => i !== -1);

  it("promptCache 在历史上打一个 breakpoint，落在倒数第二个 user turn 之前", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
    await collect(
      streamChatAnthropicSdk(config(), reactHistory(5), undefined, undefined, { promptCache: true }),
    );
    const body = bodyOf(fetchMock);
    const marked = breakpointIndices(body);
    expect(marked).toHaveLength(1);

    // 断点必须严格早于倒数第二个 user turn —— 那条是每轮唯一会变字节的位置
    // （elideStaleObservations 每轮把上一轮的完整快照翻成 marker）。打在它或
    // 它之后，每轮都命中不了，还要按 1.25x 重写整段，比不缓存更贵。
    const userIdx = body.messages
      .map((m: { role: string }, i: number) => (m.role === "user" ? i : -1))
      .filter((i: number) => i !== -1);
    const secondLastUser = userIdx[userIdx.length - 2];
    expect(marked[0]).toBeLessThan(secondLastUser);
  });

  it("断点随历史增长向后滚动（否则缓存窗口会被钉死在开头）", async () => {
    const at = async (pairs: number) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
      await collect(
        streamChatAnthropicSdk(config(), reactHistory(pairs), undefined, undefined, { promptCache: true }),
      );
      const idx = breakpointIndices(bodyOf(fetchMock))[0];
      vi.restoreAllMocks();
      return idx;
    };
    expect(await at(8)).toBeGreaterThan(await at(5));
  });

  it("历史太短时不打（Anthropic 有最小可缓存长度，白占一个 breakpoint 配额）", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
    await collect(
      streamChatAnthropicSdk(config(), reactHistory(1), undefined, undefined, { promptCache: true }),
    );
    expect(breakpointIndices(bodyOf(fetchMock))).toHaveLength(0);
  });

  it("promptCache 关闭时历史上不打任何 breakpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(TEXT_THEN_TOOL));
    await collect(streamChatAnthropicSdk(config(), reactHistory(5)));
    expect(breakpointIndices(bodyOf(fetchMock))).toHaveLength(0);
  });

  it("maps a 401 to an Invalid API key error event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const events = await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeTruthy();
    expect((err as { error: string }).error).toContain("Invalid");
  });
});

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

describe("anthropic-sdk-core max_tokens 解析", () => {
  function captureBody() {
    let captured: any = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url: any, init: any) => {
      captured = init?.body ? JSON.parse(init.body as string) : null;
      return Promise.resolve(sse(TEXT_THEN_TOOL));
    });
    return { body: () => captured };
  }

  it("用户手填 maxTokens 优先", async () => {
    const cap = captureBody();
    await collect(streamChatAnthropicSdk(config({ maxTokens: 8000, maxOutputTokens: 384_000 }), [{ role: "user", content: "hi" }]));
    expect(cap.body().max_tokens).toBe(8000);
  });

  it("无 maxTokens 时用模型 maxOutputTokens", async () => {
    const cap = captureBody();
    await collect(streamChatAnthropicSdk(config({ maxOutputTokens: 384_000 }), [{ role: "user", content: "hi" }]));
    expect(cap.body().max_tokens).toBe(384_000);
  });

  it("两者都没有时退回兜底常量（不再是 4096）", async () => {
    const cap = captureBody();
    await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    expect(cap.body().max_tokens).toBe(32_768);
  });
});
