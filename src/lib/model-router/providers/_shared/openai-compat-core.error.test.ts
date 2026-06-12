import { describe, expect, it, vi } from "vitest";
import { streamChatOpenAICompat } from "./openai-compat-core";
import type { ModelConfig } from "@/lib/model-router";

const cfg: ModelConfig = {
  provider: "managed", providerName: "Pie 官方订阅",
  model: "default", apiKey: "sk-virtual", baseUrl: "https://api.pie.chat",
};

function mockResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: false, status,
    text: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

// ok:true response whose stream read() throws mid-flight → hits the
// `Stream interrupted` catch in streamChatOpenAICompat.
function mockBrokenStreamResponse() {
  return {
    ok: true, status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => { throw new Error("connection reset"); },
        releaseLock: () => {},
      }),
    },
  } as unknown as Response;
}

async function firstEvent(resp: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => resp));
  const gen = streamChatOpenAICompat(cfg, [{ role: "user", content: "hi" }]);
  const { value } = await gen.next();
  vi.unstubAllGlobals();
  return value;
}

describe("openai-compat error.type → kind", () => {
  it("401 → kind:auth (text unchanged)", async () => {
    expect(await firstEvent(mockResponse(401, '{"error":{"type":"auth_error"}}')))
      .toMatchObject({ type: "error", kind: "auth", error: "Invalid Pie 官方订阅 API key" });
  });
  it("429 + budget_exceeded → kind:budget", async () => {
    expect(await firstEvent(mockResponse(429, '{"error":{"type":"budget_exceeded"}}')))
      .toMatchObject({ type: "error", kind: "budget" });
  });
  it("429 plain → kind:ratelimit (text unchanged)", async () => {
    expect(await firstEvent(mockResponse(429, '{"error":{"type":"rate_limit"}}', { "retry-after": "3" })))
      .toMatchObject({ type: "error", kind: "ratelimit", error: "Pie 官方订阅 rate limit exceeded. Retry after 3s" });
  });
  it("500 → kind:http", async () => {
    expect(await firstEvent(mockResponse(500, "boom")))
      .toMatchObject({ type: "error", kind: "http" });
  });
  it("stream interrupted mid-flight → kind:network", async () => {
    expect(await firstEvent(mockBrokenStreamResponse()))
      .toMatchObject({ type: "error", kind: "network" });
  });
});
