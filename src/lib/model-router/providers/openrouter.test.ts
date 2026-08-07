import { describe, it, expect, vi } from "vitest";
import { streamChat } from "./openrouter";
import type { ModelConfig } from "@/lib/model-router";

describe("openrouter wrapper", () => {
  it("attaches HTTP-Referer and X-OpenRouter-Title headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const config: ModelConfig = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) { /* drain */ }
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toMatch(/github\.com/);
    expect(headers["X-OpenRouter-Title"]).toBe("Pie");
    fetchMock.mockRestore();
  });

  it("opts into Usage Accounting so cached_tokens is reported", async () => {
    // OpenRouter 不带 usage.include 时只回 prompt/completion/total，没有
    // prompt_tokens_details —— 缓存命中数就彻底看不到了。这个字段是纯 wire 层
    // 的 opt-in，没有任何本地行为依赖它，重构时极易被顺手删掉，所以锁一下。
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const config: ModelConfig = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) { /* drain */ }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.usage).toEqual({ include: true });
    // 既有字段不能被 extraBody 挤掉。
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe("anthropic/claude-sonnet-4");
    fetchMock.mockRestore();
  });
});
