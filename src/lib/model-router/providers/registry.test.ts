import { describe, it, expect } from "vitest";
import { getProviderMeta } from "./registry";

describe("supportsVision", () => {
  it("v1 vision providers", () => {
    expect(getProviderMeta("anthropic")?.supportsVision).toBe(true);
    expect(getProviderMeta("openai")?.supportsVision).toBe(true);
    expect(getProviderMeta("openrouter")?.supportsVision).toBe(true);
  });
  it("non-vision providers (deferred to v1.1)", () => {
    expect(getProviderMeta("minimax")?.supportsVision).toBe(false);
    expect(getProviderMeta("zhipu")?.supportsVision).toBe(false);
    expect(getProviderMeta("bailian")?.supportsVision).toBe(false);
  });
});
