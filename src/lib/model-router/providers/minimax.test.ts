import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChat } from "./minimax";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage } from "../types";

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

describe("minimax wrapper (SDK-backed, Anthropic-compatible)", () => {
  it("posts to api.minimaxi.com/anthropic/v1/messages with x-api-key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(stop());
    const config: ModelConfig = {
      provider: "minimax",
      model: "MiniMax-M3",
      apiKey: "eyJ-test",
      baseUrl: "https://api.minimaxi.com",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) { /* drain */ }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("x-api-key")).toBe("eyJ-test");
    expect(h.get("authorization")).toBeNull();
  });

  it("passes M3 image input through as an Anthropic image block", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(stop());
    const config: ModelConfig = {
      provider: "minimax",
      model: "MiniMax-M3",
      apiKey: "eyJ-test",
      baseUrl: "https://api.minimaxi.com",
    };
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "BBBB" } },
          { type: "text", text: "describe" },
        ],
      },
    ];
    for await (const _ of streamChat(config, messages)) { /* drain */ }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "BBBB" },
    });
  });
});
