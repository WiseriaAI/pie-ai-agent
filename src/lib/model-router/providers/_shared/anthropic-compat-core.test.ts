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
