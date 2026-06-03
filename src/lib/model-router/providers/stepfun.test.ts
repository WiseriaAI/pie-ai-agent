import { describe, it, expect, vi } from "vitest";
import { streamChat } from "./stepfun";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition } from "../types";

describe("stepfun wrapper", () => {
  it("posts to /v1/messages (no /anthropic suffix) with Bearer auth and no anthropic-version / cache_control", async () => {
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
      provider: "stepfun",
      model: "step-3.5-flash",
      apiKey: "sk-test",
      baseUrl: "https://api.stepfun.com",
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
    expect(String(url)).toBe("https://api.stepfun.com/v1/messages");

    // The SDK passes headers as a Headers instance, so read via .get() (transport-agnostic).
    const headers = new Headers((init as RequestInit).headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
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
