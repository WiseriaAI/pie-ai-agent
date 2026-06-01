import { describe, it, expect } from "vitest";
import { getProviderMeta, getModelMeta, PROVIDER_REGISTRY, resolveModelVision } from "./registry";
import type { ModelMeta } from "./registry";

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
    const ids = ["anthropic", "openai", "zhipu", "bailian", "minimax", "gemini", "deepseek", "mimo"] as const;
    for (const id of ids) {
      const meta = getProviderMeta(id)!;
      expect(meta.models.length).toBeGreaterThan(0);
    }
  });

  it("Gemini is registered", () => {
    expect(getProviderMeta("gemini")).toBeDefined();
    expect(getProviderMeta("gemini")!.defaultBaseUrl).toBe("https://generativelanguage.googleapis.com");
  });

  it("DeepSeek is registered", () => {
    expect(getProviderMeta("deepseek")).toBeDefined();
    expect(getProviderMeta("deepseek")!.defaultBaseUrl).toBe("https://api.deepseek.com");
  });

  it("MiMo is registered", () => {
    expect(getProviderMeta("mimo")).toBeDefined();
    expect(getProviderMeta("mimo")!.defaultBaseUrl).toBe("https://api.xiaomimimo.com");
    expect(getProviderMeta("mimo")!.name).toBe("MiMo (小米)");
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

  it("MiniMax-M3 is registered with vision; M2.x is text-only", () => {
    expect(getModelMeta("minimax", "MiniMax-M3")?.vision).toBe(true);
    expect(getModelMeta("minimax", "MiniMax-M2")?.vision).toBe(false);
    // Old OpenAI-compat model ids are gone after the Anthropic-API migration.
    expect(getModelMeta("minimax", "MiniMax-Text-01")).toBeUndefined();
  });

  it("gemini-2.5-pro is registered (not gemini-2.0-pro)", () => {
    expect(getModelMeta("gemini", "gemini-2.5-pro")).toBeDefined();
    expect(getModelMeta("gemini", "gemini-2.0-pro")).toBeUndefined();
  });

  it("DeepSeek model capability flags", () => {
    expect(getModelMeta("deepseek", "deepseek-v4-flash")?.tools).toBe(true);
    expect(getModelMeta("deepseek", "deepseek-v4-flash")?.vision).toBe(false);
    expect(getModelMeta("deepseek", "deepseek-v4-flash")?.maxContextTokens).toBe(1_000_000);
  });

  it("MiMo model capability flags — pro is text-only, v2.5 has vision, omni has vision", () => {
    expect(getModelMeta("mimo", "mimo-v2.5-pro")?.tools).toBe(true);
    expect(getModelMeta("mimo", "mimo-v2.5-pro")?.vision).toBe(false);
    expect(getModelMeta("mimo", "mimo-v2.5-pro")?.maxContextTokens).toBe(1_000_000);

    expect(getModelMeta("mimo", "mimo-v2.5")?.vision).toBe(true);
    expect(getModelMeta("mimo", "mimo-v2.5")?.maxContextTokens).toBe(1_000_000);

    expect(getModelMeta("mimo", "mimo-v2-omni")?.vision).toBe(true);
    expect(getModelMeta("mimo", "mimo-v2-omni")?.maxContextTokens).toBe(256_000);
  });

  it("MiMo does NOT expose TTS models (mimo-v2.5-tts, etc.)", () => {
    expect(getModelMeta("mimo", "mimo-v2.5-tts")).toBeUndefined();
    expect(getModelMeta("mimo", "mimo-v2-tts")).toBeUndefined();
    expect(getModelMeta("mimo", "mimo-v2.5-tts-voiceclone")).toBeUndefined();
    expect(getModelMeta("mimo", "mimo-v2.5-tts-voicedesign")).toBeUndefined();
  });
});

describe("resolveModelVision — model-level vision lookup with OpenRouter fallback", () => {
  it("registry hit returns the model's vision flag (true)", () => {
    expect(resolveModelVision("anthropic", "claude-opus-4-7")).toBe(true);
  });

  it("registry hit returns the model's vision flag (false)", () => {
    expect(resolveModelVision("openai", "o3-mini")).toBe(false);
  });

  it("OpenRouter (registry empty) falls back to instance.fetchedModels — vision-capable", () => {
    const fetched: ModelMeta[] = [
      { id: "anthropic/claude-sonnet-4", vision: true, tools: true, maxContextTokens: 200_000 },
      { id: "meta-llama/llama-3-70b", vision: false, tools: true, maxContextTokens: 8_000 },
    ];
    expect(resolveModelVision("openrouter", "anthropic/claude-sonnet-4", fetched)).toBe(true);
  });

  it("OpenRouter (registry empty) falls back to instance.fetchedModels — non-vision", () => {
    const fetched: ModelMeta[] = [
      { id: "meta-llama/llama-3-70b", vision: false, tools: true, maxContextTokens: 8_000 },
    ];
    expect(resolveModelVision("openrouter", "meta-llama/llama-3-70b", fetched)).toBe(false);
  });

  it("returns undefined when model is unknown to both registry and fetchedModels (fail-open intent)", () => {
    expect(resolveModelVision("openrouter", "no-such/model")).toBeUndefined();
    expect(resolveModelVision("openrouter", "no-such/model", [])).toBeUndefined();
    expect(resolveModelVision("anthropic", "claude-from-the-future")).toBeUndefined();
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
