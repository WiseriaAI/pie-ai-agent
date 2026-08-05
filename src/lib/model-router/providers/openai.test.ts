import { describe, it, expect, vi } from "vitest";
import { streamChat, _toInputItemsForTest } from "./openai";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, StreamEvent, ToolDefinition } from "../types";

// ── mock SSE：Responses API 的 typed event 流（event: 行 + data: 行）──
function mockResponsesSse(events: Array<Record<string, unknown>>) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of events) controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const BASE: Omit<ModelConfig, "model"> = {
  provider: "openai",
  apiKey: "k",
  baseUrl: "https://api.openai.com",
};

const TOOLS: ToolDefinition[] = [
  { name: "read_page", description: "read", parameters: { type: "object", properties: {} } },
];

const COMPLETED = {
  type: "response.completed",
  response: { status: "completed", usage: { input_tokens: 7, output_tokens: 3 } },
};

async function run(config: ModelConfig, events: Array<Record<string, unknown>>, tools?: ToolDefinition[]) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponsesSse(events));
  try {
    const out: StreamEvent[] = [];
    for await (const ev of streamChat(config, [{ role: "user", content: "hi" }], undefined, tools)) out.push(ev);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    return { out, url, body: JSON.parse(init.body as string) as Record<string, unknown> };
  } finally {
    fetchMock.mockRestore();
  }
}

describe("openai /v1/responses request shape", () => {
  it("posts to {baseUrl}/v1/responses with store:false and stream:true", async () => {
    const { url, body } = await run({ ...BASE, model: "gpt-5.6-sol" }, [COMPLETED]);
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-5.6-sol");
  });

  it("maxTokens maps to max_output_tokens (never max_tokens)", async () => {
    const { body } = await run({ ...BASE, model: "gpt-5.6-sol", maxTokens: 16 }, [COMPLETED]);
    expect(body.max_output_tokens).toBe(16);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("omits max_output_tokens when maxTokens unset", async () => {
    const { body } = await run({ ...BASE, model: "gpt-5.6-sol" }, [COMPLETED]);
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  it("tools use the flat Responses shape with tool_choice auto", async () => {
    const { body } = await run({ ...BASE, model: "gpt-5.6-sol" }, [COMPLETED], TOOLS);
    expect(body.tools).toEqual([
      { type: "function", name: "read_page", description: "read", parameters: { type: "object", properties: {} } },
    ]);
    expect(body.tool_choice).toBe("auto");
    // chat-completions 时代的 hotfix 字段不得再出现
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("openai toInputItems", () => {
  it("system / user / assistant strings become typed message items", () => {
    const items = _toInputItemsForTest([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(items).toEqual([
      { role: "system", content: [{ type: "input_text", text: "sys" }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hi there" }] },
    ]);
  });

  it("assistant [text, tool_use] becomes assistant message + function_call items", () => {
    const items = _toInputItemsForTest([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "call_1", name: "read_page", input: { mode: "auto" } },
        ],
      },
    ]);
    expect(items).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "let me check" }] },
      { type: "function_call", call_id: "call_1", name: "read_page", arguments: '{"mode":"auto"}' },
    ]);
  });

  it("user [tool_result, text] becomes function_call_output + user message", () => {
    const items = _toInputItemsForTest([
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_1", content: "result text" },
          { type: "text", text: "follow-up" },
        ],
      },
    ]);
    expect(items).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "result text" },
      { role: "user", content: [{ type: "input_text", text: "follow-up" }] },
    ]);
  });

  it("user [image, text] becomes one message with input_image + input_text parts", () => {
    const items = _toInputItemsForTest([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } },
          { type: "text", text: "what is this?" },
        ],
      },
    ] as AgentMessage[]);
    expect(items).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/jpeg;base64,AAAA" },
          { type: "input_text", text: "what is this?" },
        ],
      },
    ]);
  });
});

describe("openai /v1/responses stream mapping", () => {
  it("output_text deltas + completed → text-delta events + done(end) with usage", async () => {
    const { out } = await run({ ...BASE, model: "gpt-5.6-sol" }, [
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hel" },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "lo" },
      COMPLETED,
    ]);
    expect(out).toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "done", stopReason: "end", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
  });

  it("function_call item flow → tool-call start/delta/end + done(tool_calls)", async () => {
    const { out } = await run({ ...BASE, model: "gpt-5.6-sol" }, [
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read_page", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"mode":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"auto"}' },
      {
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read_page", arguments: '{"mode":"auto"}' },
      },
      COMPLETED,
    ], TOOLS);
    expect(out).toEqual([
      { type: "tool-call-start", id: "call_9", index: 0, name: "read_page" },
      { type: "tool-call-delta", index: 0, argsDelta: '{"mode":' },
      { type: "tool-call-delta", index: 0, argsDelta: '"auto"}' },
      { type: "tool-call-end", index: 0 },
      { type: "done", stopReason: "tool_calls", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
  });

  it("incomplete(max_output_tokens) → done(length)", async () => {
    const { out } = await run({ ...BASE, model: "gpt-5.6-sol" }, [
      { type: "response.output_text.delta", item_id: "m", delta: "par" },
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 7, output_tokens: 3 } },
      },
    ]);
    expect(out[out.length - 1]).toEqual({
      type: "done",
      stopReason: "length",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it("response.failed → error event", async () => {
    const { out } = await run({ ...BASE, model: "gpt-5.6-sol" }, [
      { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } },
    ]);
    expect(out).toEqual([{ type: "error", error: expect.stringContaining("boom"), kind: "http" }]);
  });

  it("non-200 http status → error event with status and body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":{"message":"bad"}}', { status: 400 }),
    );
    try {
      const out: StreamEvent[] = [];
      for await (const ev of streamChat({ ...BASE, model: "gpt-5.6-sol" }, [{ role: "user", content: "hi" }])) out.push(ev);
      expect(out).toEqual([{ type: "error", error: expect.stringContaining("(400)"), kind: "http" }]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("401 → auth-kind error", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    try {
      const out: StreamEvent[] = [];
      for await (const ev of streamChat({ ...BASE, model: "gpt-5.6-sol" }, [{ role: "user", content: "hi" }])) out.push(ev);
      expect(out).toEqual([{ type: "error", error: expect.stringContaining("API key"), kind: "auth" }]);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
