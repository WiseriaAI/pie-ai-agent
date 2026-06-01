import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChatOpenAICompat } from "./openai-compat-core";
import type { ModelConfig } from "@/lib/model-router";
import type { StreamEvent } from "@/lib/model-router/types";

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

// Helper: raw SSE chunks (no auto-appended newlines, unlike mockSseResponse)
function sseRaw(lines: string[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(l));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const thinkingCfg = { provider: "openai", model: "m", apiKey: "k", baseUrl: "https://api.openai.com" } as ModelConfig;

async function collectEvents(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("openai-compat thinking", () => {
  it("maps reasoning_content to thinking events (replay:false), not text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseRaw([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking…"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const ev = await collectEvents(streamChatOpenAICompat(thinkingCfg, [{ role: "user", content: "hi" }]));
    const types = ev.map((e) => e.type);
    expect(types).toContain("thinking-start");
    expect(ev.find((e) => e.type === "thinking-start")).toMatchObject({ replay: false });
    expect(ev.find((e) => e.type === "thinking-delta")).toMatchObject({ text: "thinking…" });
    expect(ev.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("answer");
    const tEnd = types.indexOf("thinking-end");
    const firstText = types.indexOf("text-delta");
    expect(tEnd).toBeGreaterThanOrEqual(0);
    expect(tEnd).toBeLessThan(firstText);
  });

  it("splits inline <think> tags out of content (replay:false)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseRaw([
        'data: {"choices":[{"delta":{"content":"<think>plan</think>done"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const ev = await collectEvents(streamChatOpenAICompat(thinkingCfg, [{ role: "user", content: "hi" }]));
    expect(ev.find((e) => e.type === "thinking-delta")).toMatchObject({ text: "plan" });
    expect(ev.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("done");
  });

  it("leaves plain content unaffected (no thinking events)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseRaw([
        'data: {"choices":[{"delta":{"content":"hello"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const ev = await collectEvents(streamChatOpenAICompat(thinkingCfg, [{ role: "user", content: "hi" }]));
    expect(ev.some((e) => e.type.startsWith("thinking"))).toBe(false);
    expect(ev.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("hello");
  });
});
