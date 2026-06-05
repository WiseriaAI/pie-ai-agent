import { describe, it, expect, vi } from "vitest";
import { streamChat } from "./mimo";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition } from "../types";

describe("mimo wrapper", () => {
  it("posts to /anthropic/v1/messages with Bearer auth and no anthropic-version / cache_control", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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

    const config = {
      provider: "mimo",
      model: "mimo-v2.5-pro",
      apiKey: "mk-test",
      baseUrl: "https://token-plan-cn.xiaomimimo.com",
    } as ModelConfig;
    const messages: AgentMessage[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "hi" },
    ];
    const tools: ToolDefinition[] = [
      { name: "click", description: "click", parameters: { type: "object" } },
    ];

    for await (const _ of streamChat(config, messages, undefined, tools)) { /* drain */ }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");

    // The SDK passes headers as a Headers instance, so read via .get() (transport-agnostic).
    const headers = new Headers((init as RequestInit).headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer mk-test");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("anthropic-version")).toBeNull();

    const body = JSON.parse((init as RequestInit).body as string);
    expect(typeof body.system).toBe("string");
    expect(body.system).toBe("you are an agent");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].cache_control).toBeUndefined();

    fetchMock.mockRestore();
  });
});
