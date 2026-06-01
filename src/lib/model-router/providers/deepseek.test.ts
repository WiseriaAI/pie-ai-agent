import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChat } from "./deepseek";
import type { ModelConfig } from "@/lib/model-router";
import type { ToolDefinition } from "../types";

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

afterEach(() => vi.restoreAllMocks());

describe("deepseek wrapper (SDK-backed, Anthropic-compatible)", () => {
  it("posts to /anthropic/v1/messages with x-api-key and no prompt cache", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(stop());
    const config: ModelConfig = {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
    };
    const tools: ToolDefinition[] = [
      { name: "click", description: "click", parameters: { type: "object" } },
    ];
    for await (const _ of streamChat(config, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], undefined, tools)) { /* drain */ }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.deepseek.com/anthropic/v1/messages");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("x-api-key")).toBe("sk-test");
    expect(h.get("authorization")).toBeNull();
    const body = JSON.parse((init as RequestInit).body as string);
    expect(typeof body.system).toBe("string"); // not cached → plain string, not block array
    expect(body.tools[0].cache_control).toBeUndefined();
  });
});
