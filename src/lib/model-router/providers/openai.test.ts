import { describe, it, expect, vi } from "vitest";
import { streamChat, _toWireMessagesForTest } from "./openai";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition } from "../types";

function mockSseResponse(lines: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l + "\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureRequestBody(config: ModelConfig, tools?: ToolDefinition[]) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    mockSseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"]),
  );
  try {
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }], undefined, tools)) {
      void _;
    }
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  } finally {
    fetchMock.mockRestore();
  }
}

const TOOLS: ToolDefinition[] = [
  { name: "read_page", description: "read", parameters: { type: "object", properties: {} } },
];

// gpt-5.x reasoning 系在 /v1/chat/completions 拒收 max_tokens、且 tools 与
// reasoning_effort≠none 互斥（gpt-5.6 起 enforce）。gpt-4o 两个字段都认。
describe("openai request-body quirks", () => {
  const base: Omit<ModelConfig, "model"> = {
    provider: "openai",
    apiKey: "k",
    baseUrl: "https://api.openai.com",
  };

  it("maxTokens is sent as max_completion_tokens, never max_tokens", async () => {
    const body = await captureRequestBody({ ...base, model: "gpt-5.6-sol", maxTokens: 16 });
    expect(body.max_completion_tokens).toBe(16);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("gpt-5.6 family with tools sets reasoning_effort none", async () => {
    const body = await captureRequestBody({ ...base, model: "gpt-5.6-sol" }, TOOLS);
    expect(body.reasoning_effort).toBe("none");
  });

  it("gpt-5.6 without tools leaves reasoning_effort unset", async () => {
    const body = await captureRequestBody({ ...base, model: "gpt-5.6-luna" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("non-5.6 models with tools leave reasoning_effort unset", async () => {
    for (const model of ["gpt-5.5", "gpt-4o"]) {
      const body = await captureRequestBody({ ...base, model }, TOOLS);
      expect(body).not.toHaveProperty("reasoning_effort");
    }
  });
});

describe("openai toWireMessages — image", () => {
  it("user message with [image, text] becomes single wire msg with content array", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" },
          },
          { type: "text", text: "what is this?" },
        ],
      },
    ];
    const wire = _toWireMessagesForTest(msgs);
    expect(wire).toHaveLength(1);
    expect(wire[0].role).toBe("user");
    const content = wire[0].content as Array<{ type: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,AAAA" },
    });
    expect(content[1]).toEqual({ type: "text", text: "what is this?" });
  });

  it("user message with [tool_result, text] still splits into tool + user msgs (unchanged behavior)", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "tu1", content: "result text" },
          { type: "text", text: "follow-up text" },
        ],
      },
    ];
    const wire = _toWireMessagesForTest(msgs);
    expect(wire).toHaveLength(2);
    expect(wire[0].role).toBe("tool");
    expect(wire[0].tool_call_id).toBe("tu1");
    expect(wire[0].content).toBe("result text");
    expect(wire[1].role).toBe("user");
    expect(wire[1].content).toBe("follow-up text");
  });
});

// NOTE: The old "openai supportsVision wiring" describe block was checking
// ProviderMeta.type and ProviderMeta.supportsVision, both removed in Task 1
// (registry schema upgrade). The dispatch is now id-keyed via streamChatByProvider
// in providers/index.ts; vision is per-model via getModelMeta. Those paths are
// covered in registry.test.ts. Removed here to avoid false failures.
