import { describe, it, expect } from "vitest";
import { _toWireMessagesForTest, _buildRequestBodyForTest } from "./anthropic";
import type { AgentMessage, ToolDefinition } from "../types";
import type { ModelConfig } from "@/lib/model-router";

describe("anthropic toWireMessages — image", () => {
  it("ImageBlock passes through with snake_case media_type", () => {
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
    expect(wire.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
    expect(wire.messages[0].content[1]).toEqual({ type: "text", text: "what is this?" });
  });
});

describe("anthropic prompt caching — cache_control breakpoints", () => {
  const config: ModelConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "sk-test",
    baseUrl: "https://api.anthropic.com",
  };
  const systemMsg: AgentMessage = { role: "system", content: "You are an agent." };
  const userMsg: AgentMessage = { role: "user", content: "do the thing" };
  const tools: ToolDefinition[] = [
    { name: "click", description: "click an element", parameters: { type: "object" } },
    { name: "type", description: "type text", parameters: { type: "object" } },
  ];

  it("marks the last tool definition with cache_control ephemeral", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], tools);
    const wireTools = body.tools as Array<Record<string, unknown>>;
    expect(wireTools).toHaveLength(2);
    // Only the last tool carries the breakpoint — it caches the whole tools prefix.
    expect(wireTools[0].cache_control).toBeUndefined();
    expect(wireTools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts the system string to a block array with a cache_control breakpoint", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], tools);
    expect(body.system).toEqual([
      { type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("still caches the system prefix when no tools are present", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], undefined);
    expect(body.tools).toBeUndefined();
    expect(body.system).toEqual([
      { type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("omits the system field entirely when there is no system message", () => {
    const body = _buildRequestBodyForTest(config, [userMsg], undefined);
    expect(body.system).toBeUndefined();
  });

  it("preserves model, messages, stream and max_tokens", () => {
    const body = _buildRequestBodyForTest(
      { ...config, maxTokens: 2048 },
      [systemMsg, userMsg],
      tools,
    );
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: "user", content: "do the thing" }]);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });
});
