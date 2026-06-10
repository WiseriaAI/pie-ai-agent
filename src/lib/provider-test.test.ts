import { describe, expect, it, vi } from "vitest";
import { testProviderConnection } from "./provider-test";
import type { ChatMessage, ChatResponse, ModelConfig } from "./model-router";

describe("testProviderConnection", () => {
  it("sends a real user-only probe request with baseUrl and apiKey", async () => {
    const chatImpl = vi.fn(
      async (_config: ModelConfig, _messages: ChatMessage[]): Promise<ChatResponse> => ({ content: "ok" }),
    );

    await testProviderConnection(
      {
        provider: "custom:cp1",
        providerName: "Proxy",
        model: "gpt-test",
        apiKey: "sk-test",
        baseUrl: "https://proxy.test/v1",
      },
      { chatImpl, timeoutMs: 100 },
    );

    expect(chatImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom:cp1",
        providerName: "Proxy",
        model: "gpt-test",
        apiKey: "sk-test",
        baseUrl: "https://proxy.test/v1",
        maxTokens: 1,
      }),
      [{ role: "user", content: "Hi" }],
      expect.any(AbortSignal),
    );
  });

  it("fails with timeout when the probe does not finish in time", async () => {
    const chatImpl = vi.fn(
      () => new Promise<ChatResponse>(() => {}),
    );

    await expect(
      testProviderConnection(
        {
          provider: "openai",
          model: "gpt-test",
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com",
        },
        { chatImpl, timeoutMs: 1 },
      ),
    ).rejects.toThrow("timeout");
  });
});
