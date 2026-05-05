import { describe, it, expect } from "vitest";
import { getProviderMeta, getModelMeta, PROVIDER_REGISTRY } from "./registry";

describe("ProviderMeta schema", () => {
  it("every provider has a defaultBaseUrl, placeholder, and models[]", () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.defaultBaseUrl).toMatch(/^https:\/\//);
      expect(typeof p.placeholder).toBe("string");
      expect(Array.isArray(p.models)).toBe(true);
    }
  });

  it("ProviderMeta no longer carries supportsVision / supportsTools / maxContextTokens / defaultModel / type", () => {
    const meta = getProviderMeta("anthropic")!;
    expect("supportsVision" in meta).toBe(false);
    expect("supportsTools" in meta).toBe(false);
    expect("maxContextTokens" in meta).toBe(false);
    expect("defaultModel" in meta).toBe(false);
    expect("type" in meta).toBe(false);
  });

  it("OpenRouter has empty models[] and modelsEndpoint set (lazy fetch)", () => {
    const meta = getProviderMeta("openrouter")!;
    expect(meta.models).toEqual([]);
    expect(meta.modelsEndpoint).toBe("/v1/models");
  });

  it("non-OpenRouter providers have non-empty models[] (hardcoded)", () => {
    const ids = ["anthropic", "openai", "zhipu", "bailian", "minimax", "gemini"] as const;
    for (const id of ids) {
      const meta = getProviderMeta(id)!;
      expect(meta.models.length).toBeGreaterThan(0);
    }
  });

  it("Gemini is registered", () => {
    expect(getProviderMeta("gemini")).toBeDefined();
    expect(getProviderMeta("gemini")!.defaultBaseUrl).toBe("https://generativelanguage.googleapis.com");
  });
});

describe("ModelMeta capability flags (per-model)", () => {
  it("claude-opus-4-7 has vision + tools", () => {
    const m = getModelMeta("anthropic", "claude-opus-4-7")!;
    expect(m.vision).toBe(true);
    expect(m.tools).toBe(true);
    expect(m.maxContextTokens).toBeGreaterThan(100_000);
  });

  it("gpt-4o has vision; gpt-4o-mini also has vision", () => {
    expect(getModelMeta("openai", "gpt-4o")?.vision).toBe(true);
    expect(getModelMeta("openai", "gpt-4o-mini")?.vision).toBe(true);
  });

  it("ZhiPu glm-4-plus does NOT have vision; glm-4v-plus does", () => {
    expect(getModelMeta("zhipu", "glm-4-plus")?.vision).toBe(false);
    expect(getModelMeta("zhipu", "glm-4v-plus")?.vision).toBe(true);
  });

  it("Bailian qwen-max does NOT have vision; qwen-vl-max does", () => {
    expect(getModelMeta("bailian", "qwen-max")?.vision).toBe(false);
    expect(getModelMeta("bailian", "qwen-vl-max")?.vision).toBe(true);
  });

  it("getModelMeta returns undefined for unknown model", () => {
    expect(getModelMeta("anthropic", "no-such-model")).toBeUndefined();
  });

  it("gpt-4o has tools: true", () => {
    expect(getModelMeta("openai", "gpt-4o")?.tools).toBe(true);
  });

  it("o3 has vision: true; o3-mini has vision: false (text-only)", () => {
    expect(getModelMeta("openai", "o3")?.vision).toBe(true);
    expect(getModelMeta("openai", "o3-mini")?.vision).toBe(false);
  });

  it("glm-4v-plus maxContextTokens is 16K", () => {
    expect(getModelMeta("zhipu", "glm-4v-plus")?.maxContextTokens).toBe(16_000);
  });

  it("MiniMax-VL-01 is registered (not MiniMax-VL)", () => {
    expect(getModelMeta("minimax", "MiniMax-VL-01")).toBeDefined();
    expect(getModelMeta("minimax", "MiniMax-VL")).toBeUndefined();
  });

  it("gemini-2.5-pro is registered (not gemini-2.0-pro)", () => {
    expect(getModelMeta("gemini", "gemini-2.5-pro")).toBeDefined();
    expect(getModelMeta("gemini", "gemini-2.0-pro")).toBeUndefined();
  });
});

describe("Per-provider model id uniqueness", () => {
  it("no provider has duplicate model ids", () => {
    for (const provider of PROVIDER_REGISTRY) {
      const ids = provider.models.map((m) => m.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    }
  });
});
