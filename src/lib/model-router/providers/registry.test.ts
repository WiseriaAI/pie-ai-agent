import { describe, it, expect, beforeEach } from "vitest";
import { getProviderMeta, getModelMeta, PROVIDER_REGISTRY, resolveModelVision, resolveModelMeta } from "./registry";
import type { ModelMeta } from "./registry";
import { setProviderCustomModelMeta } from "@/lib/provider-custom-model-meta";
import { chromeMock } from "@/test/setup";

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
    const ids = ["anthropic", "openai", "zhipu", "bailian", "minimax", "gemini", "deepseek", "mimo", "moonshot", "moonshot-cn", "stepfun"] as const;
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
    expect(getProviderMeta("mimo")!.defaultBaseUrl).toBe("https://token-plan-cn.xiaomimimo.com");
    expect(getProviderMeta("mimo")!.name).toBe("Mimo(Xiaomi)");
  });

  it("StepFun is registered", () => {
    expect(getProviderMeta("stepfun")).toBeDefined();
    expect(getProviderMeta("stepfun")!.defaultBaseUrl).toBe("https://api.stepfun.com");
    expect(getProviderMeta("stepfun")!.name).toBe("StepFun");
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

  it("ZhiPu glm-4.7 does NOT have vision; glm-4.6v does", () => {
    expect(getModelMeta("zhipu", "glm-4.7")?.vision).toBe(false);
    expect(getModelMeta("zhipu", "glm-4.6v")?.vision).toBe(true);
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

  it("glm-4v-flash maxContextTokens is 16K", () => {
    expect(getModelMeta("zhipu", "glm-4v-flash")?.maxContextTokens).toBe(16_000);
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

  it("StepFun model capability flags — 3.7-flash is multimodal, 3.5-flash is text-only", () => {
    expect(getModelMeta("stepfun", "step-3.7-flash")?.vision).toBe(true);
    expect(getModelMeta("stepfun", "step-3.7-flash")?.tools).toBe(true);
    expect(getModelMeta("stepfun", "step-3.7-flash")?.maxContextTokens).toBe(256_000);

    expect(getModelMeta("stepfun", "step-3.5-flash")?.vision).toBe(false);
    expect(getModelMeta("stepfun", "step-3.5-flash")?.tools).toBe(true);
    expect(getModelMeta("stepfun", "step-3.5-flash")?.maxContextTokens).toBe(256_000);
  });

  it("StepFun does NOT expose the step_plan-only router model", () => {
    expect(getModelMeta("stepfun", "step-router-v1")).toBeUndefined();
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

describe("resolveModelMeta + pcmm", () => {
  beforeEach(() => { chromeMock.storage.local.__store = {}; });

  it("builtin custom id resolves from pcmm with tools forced true", async () => {
    await setProviderCustomModelMeta("minimax", "MiniMax-Future", { vision: true, maxContextTokens: 1_000_000 });
    const meta = await resolveModelMeta("minimax", "MiniMax-Future");
    expect(meta).toMatchObject({ id: "MiniMax-Future", vision: true, tools: true, maxContextTokens: 1_000_000 });
  });

  it("registry preset wins over pcmm (preset not overridable)", async () => {
    await setProviderCustomModelMeta("minimax", "MiniMax-M3", { vision: false, maxContextTokens: 1 });
    const meta = await resolveModelMeta("minimax", "MiniMax-M3");
    expect(meta?.maxContextTokens).toBe(1_000_000); // preset value, not pcmm's 1
    expect(meta?.vision).toBe(true);
  });

  it("unknown id with no pcmm returns null", async () => {
    expect(await resolveModelMeta("minimax", "no-such-model")).toBeNull();
  });

  it("pcmm displayName propagates into resolved meta", async () => {
    await setProviderCustomModelMeta("minimax", "Named-Model", { displayName: "My Model", vision: false, maxContextTokens: 256_000 });
    const meta = await resolveModelMeta("minimax", "Named-Model");
    expect(meta?.displayName).toBe("My Model");
  });
});

describe("Moonshot (Kimi) — dual-region registration", () => {
  it("international entry registered with api.moonshot.ai", () => {
    const meta = getProviderMeta("moonshot")!;
    expect(meta).toBeDefined();
    expect(meta.defaultBaseUrl).toBe("https://api.moonshot.ai");
    expect(meta.name).toBe("Moonshot(Kimi)");
  });

  it("China entry registered with api.moonshot.cn", () => {
    const meta = getProviderMeta("moonshot-cn")!;
    expect(meta).toBeDefined();
    expect(meta.defaultBaseUrl).toBe("https://api.moonshot.cn");
    expect(meta.name).toBe("Moonshot(Kimi) China");
  });

  it("both regions expose the same model list", () => {
    const intl = getProviderMeta("moonshot")!.models.map((m) => m.id);
    const cn = getProviderMeta("moonshot-cn")!.models.map((m) => m.id);
    expect(cn).toEqual(intl);
    expect(intl).toContain("kimi-k2.6");
  });

  it("kimi-k2.6 / kimi-k2.5 have vision + tools + 256K context", () => {
    for (const id of ["kimi-k2.6", "kimi-k2.5"]) {
      const m = getModelMeta("moonshot", id)!;
      expect(m.vision).toBe(true);
      expect(m.tools).toBe(true);
      expect(m.maxContextTokens).toBe(256_000);
    }
  });

  it("moonshot-v1-128k is text-only with tools (128K)", () => {
    const m = getModelMeta("moonshot", "moonshot-v1-128k")!;
    expect(m.vision).toBe(false);
    expect(m.tools).toBe(true);
    expect(m.maxContextTokens).toBe(128_000);
  });

  it("moonshot-v1-32k is text-only with tools (32K)", () => {
    const m = getModelMeta("moonshot", "moonshot-v1-32k")!;
    expect(m.vision).toBe(false);
    expect(m.tools).toBe(true);
    expect(m.maxContextTokens).toBe(32_000);
  });
});
