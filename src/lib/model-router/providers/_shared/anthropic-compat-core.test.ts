import { describe, it, expect } from "vitest";
import { _buildRequestBodyForTest } from "./anthropic-compat-core";
import type { AgentMessage, ToolDefinition } from "@/lib/model-router/types";
import type { ModelConfig } from "@/lib/model-router";

const config: ModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "sk-test",
  baseUrl: "https://api.anthropic.com",
};
const systemMsg: AgentMessage = { role: "system", content: "You are an agent." };
const userMsg: AgentMessage = { role: "user", content: "do the thing" };
const tools: ToolDefinition[] = [
  { name: "click", description: "click", parameters: { type: "object" } },
  { name: "type", description: "type", parameters: { type: "object" } },
];

describe("anthropic-compat-core: tool_result wire shape", () => {
  it("translates tool_result block fields to snake_case (tool_use_id, is_error)", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_abc", content: "ok" },
          { type: "tool_result", toolUseId: "toolu_def", content: "bad", isError: true },
        ],
      },
    ];
    const body = _buildRequestBodyForTest(config, msgs, undefined, false);
    const wireMessages = body.messages as Array<{ role: string; content: unknown[] }>;
    expect(wireMessages[0].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_abc",
      content: "ok",
    });
    expect(wireMessages[0].content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_def",
      content: "bad",
      is_error: true,
    });
  });

  it("does not emit camelCase toolUseId / isError fields on the wire", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "toolu_abc", content: "ok", isError: false }],
      },
    ];
    const body = _buildRequestBodyForTest(config, msgs, undefined, false);
    const wireMessages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const block = wireMessages[0].content[0];
    expect(block.toolUseId).toBeUndefined();
    expect(block.isError).toBeUndefined();
    expect(block.tool_use_id).toBe("toolu_abc");
    expect(block.is_error).toBe(false);
  });
});

describe("anthropic-compat-core: promptCache hook", () => {
  it("promptCache=false produces a plain string system field (no block array, no cache_control)", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], tools, false);
    expect(body.system).toBe("You are an agent.");
  });

  it("promptCache=false leaves tools without cache_control", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], tools, false);
    const wireTools = body.tools as Array<Record<string, unknown>>;
    expect(wireTools).toHaveLength(2);
    expect(wireTools[0].cache_control).toBeUndefined();
    expect(wireTools[1].cache_control).toBeUndefined();
  });

  it("promptCache=true still produces the cached-breakpoint shape (default for anthropic native)", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], tools, true);
    expect(body.system).toEqual([
      { type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } },
    ]);
    const wireTools = body.tools as Array<Record<string, unknown>>;
    expect(wireTools[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

import { vi } from "vitest";
import { streamChatAnthropicCompat } from "./anthropic-compat-core";

function mockEmptyStream() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("event: message_stop\ndata: {}\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
}

describe("anthropic-compat-core: endpoint and header hooks", () => {
  it("default endpointPath is /v1/messages", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg])) { /* drain */ }
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
    fetchMock.mockRestore();
  });

  it("hooks.endpointPath overrides the request URL suffix", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg], undefined, undefined, {
      endpointPath: "/anthropic/v1/messages",
    })) { /* drain */ }
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/anthropic/v1/messages");
    fetchMock.mockRestore();
  });

  it("default auth headers are x-api-key + anthropic-version", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg])) { /* drain */ }
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("hooks.authHeaders fully replaces the default auth set", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg], undefined, undefined, {
      authHeaders: (c) => ({ authorization: `Bearer ${c.apiKey}` }),
    })) { /* drain */ }
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("hooks.customHeaders are merged on top of auth", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg], undefined, undefined, {
      customHeaders: () => ({ "x-trace-id": "abc" }),
    })) { /* drain */ }
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-trace-id"]).toBe("abc");
    expect(headers["x-api-key"]).toBe("sk-test");
    fetchMock.mockRestore();
  });
});
