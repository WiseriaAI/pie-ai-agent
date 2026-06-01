import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChat } from "./anthropic";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition } from "../types";

function stop(): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("event: message_stop\ndata: {}\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const config: ModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "sk-test",
  baseUrl: "https://api.anthropic.com",
};

afterEach(() => vi.restoreAllMocks());

describe("anthropic wrapper (SDK-backed)", () => {
  it("posts to /v1/messages with x-api-key + anthropic-version", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(stop());
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) { /* drain */ }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("x-api-key")).toBe("sk-test");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.get("authorization")).toBeNull();
  });

  it("enables prompt caching: system block + last tool carry cache_control", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(stop());
    const tools: ToolDefinition[] = [
      { name: "click", description: "click", parameters: { type: "object" } },
      { name: "type", description: "type", parameters: { type: "object" } },
    ];
    const messages: AgentMessage[] = [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "go" },
    ];
    for await (const _ of streamChat(config, messages, undefined, tools)) { /* drain */ }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.system).toEqual([
      { type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("passes image blocks through with snake_case media_type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(stop());
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } },
          { type: "text", text: "what is this?" },
        ],
      },
    ];
    for await (const _ of streamChat(config, messages)) { /* drain */ }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
    expect(body.messages[0].content[1]).toEqual({ type: "text", text: "what is this?" });
  });
});
