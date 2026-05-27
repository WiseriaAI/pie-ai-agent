import { describe, it, expect } from "vitest";
import { streamChatByProvider } from "./providers";

describe("streamChatByProvider dispatch table", () => {
  it("has a streamChat function for every Provider in the union", () => {
    const expected = ["anthropic", "openai", "openrouter", "zhipu", "bailian", "minimax", "gemini", "deepseek", "mimo"] as const;
    for (const id of expected) {
      expect(typeof streamChatByProvider[id]).toBe("function");
    }
  });
});
