import { describe, it, expect, vi } from "vitest";
import { streamChatOpenAICompat } from "./openai-compat-core";
import type { ModelConfig } from "@/lib/model-router";

function mockSseResponse(lines: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l + "\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("streamChatOpenAICompat", () => {
  it("hooks.customHeaders are merged into the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "data: [DONE]",
      ]),
    );
    const config: ModelConfig = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      apiKey: "test-key",
      baseUrl: "https://example.test",
    };
    const events: unknown[] = [];
    for await (const ev of streamChatOpenAICompat(config, [{ role: "user", content: "hi" }], undefined, undefined, {
      customHeaders: () => ({ "X-Custom": "yes" }),
    })) {
      events.push(ev);
    }
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Custom"]).toBe("yes");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    fetchMock.mockRestore();
  });

  it("ZhiPu/Bailian quirk: [DONE] without finish_reason still flushes pending tool_calls", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockSseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"foo","arguments":"{\\"x\\":1}"}}]}}]}',
        "data: [DONE]",
      ]),
    );
    const config: ModelConfig = {
      provider: "zhipu",
      model: "glm-4-plus",
      apiKey: "k",
      baseUrl: "https://example.test/v4",
    };
    const events: { type: string }[] = [];
    for await (const ev of streamChatOpenAICompat(config, [{ role: "user", content: "x" }])) {
      events.push(ev as { type: string });
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("tool-call-end");
    const done = events.find((e) => e.type === "done") as { type: "done"; stopReason: string };
    expect(done.stopReason).toBe("tool_calls");
    fetchMock.mockRestore();
  });

  it("hooks.authHeaders replaces default Bearer (not merged)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "data: [DONE]",
      ]),
    );
    const config: ModelConfig = {
      provider: "bailian",
      model: "qwen-max",
      apiKey: "ignored",
      baseUrl: "https://example.test",
    };
    for await (const _ of streamChatOpenAICompat(config, [{ role: "user", content: "hi" }], undefined, undefined, {
      authHeaders: () => ({ "X-Custom-Auth": "secret-token" }),
    })) { /* drain */ }
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Custom-Auth"]).toBe("secret-token");
    expect(headers.authorization).toBeUndefined();
    fetchMock.mockRestore();
  });
});
