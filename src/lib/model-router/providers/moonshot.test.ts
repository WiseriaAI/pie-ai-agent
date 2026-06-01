import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChat } from "./moonshot";
import type { ModelConfig } from "@/lib/model-router";

function done(): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("moonshot wrapper (OpenAI-compat, dual-region)", () => {
  it("international entry posts to api.moonshot.ai/v1/chat/completions with Bearer auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(done());
    const config: ModelConfig = {
      provider: "moonshot",
      model: "kimi-k2.6",
      apiKey: "sk-test",
      baseUrl: "https://api.moonshot.ai",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) {
      /* drain */
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.moonshot.ai/v1/chat/completions");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("authorization")).toBe("Bearer sk-test");
    // zero-hook wrapper → no provider-specific custom headers (unlike OpenRouter)
    expect(h.get("HTTP-Referer")).toBeNull();
  });

  it("China entry posts to api.moonshot.cn/v1/chat/completions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(done());
    const config: ModelConfig = {
      provider: "moonshot-cn",
      model: "kimi-k2.6",
      apiKey: "sk-test",
      baseUrl: "https://api.moonshot.cn",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) {
      /* drain */
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.moonshot.cn/v1/chat/completions");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("authorization")).toBe("Bearer sk-test");
  });
});
