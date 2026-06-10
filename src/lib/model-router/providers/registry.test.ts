import { describe, it, expect, beforeEach } from "vitest";
import { getProviderMeta, getModelMeta, PROVIDER_REGISTRY, resolveModelVision, resolveModelMeta, resolveEndpointVariant } from "./registry";
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
    // Default endpoint is the Step Plan (subscription); pay-as-you-go is a variant.
    expect(getProviderMeta("stepfun")!.defaultBaseUrl).toBe("https://api.stepfun.com/step_plan");
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

  it("gpt-5.5 flagship is registered with vision + tools + 1.05M context", () => {
    const m = getModelMeta("openai", "gpt-5.5")!;
    expect(m.vision).toBe(true);
    expect(m.tools).toBe(true);
    expect(m.maxContextTokens).toBe(1_050_000);
  });

  it("gpt-5.4 series is registered (mini/nano at 400K, flagship at 1.05M)", () => {
    expect(getModelMeta("openai", "gpt-5.4")?.maxContextTokens).toBe(1_050_000);
    expect(getModelMeta("openai", "gpt-5.4-mini")?.maxContextTokens).toBe(400_000);
    expect(getModelMeta("openai", "gpt-5.4-nano")?.vision).toBe(true);
  });

  it("OpenAI does NOT expose realtime / image / TTS models", () => {
    expect(getModelMeta("openai", "gpt-image-2")).toBeUndefined();
    expect(getModelMeta("openai", "gpt-realtime-2")).toBeUndefined();
    expect(getModelMeta("openai", "gpt-4o-mini-tts")).toBeUndefined();
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

  it("StepFun exposes the router model on Step Plan (default) but not on pay-as-you-go", () => {
    // After the default→Plan flip, step-router-v1 lives in the default (Step Plan)
    // model list; the pay-as-you-go variant pool intentionally omits it.
    expect(getProviderMeta("stepfun")!.models.find((m) => m.id === "step-router-v1")).toBeDefined();
    const payg = getProviderMeta("stepfun")!.endpointVariants!.find((v) => v.id === "payg")!;
    expect(payg.models!.find((m) => m.id === "step-router-v1")).toBeUndefined();
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
  // After the default→Plan flip both entries default to the single global Kimi
  // Code endpoint (no region split for the subscription); the region distinction
  // moved to the pay-as-you-go variant (api.moonshot.ai vs api.moonshot.cn).
  it("international entry defaults to Kimi Code, payg variant on api.moonshot.ai", () => {
    const meta = getProviderMeta("moonshot")!;
    expect(meta).toBeDefined();
    expect(meta.defaultBaseUrl).toBe("https://api.kimi.com/coding");
    expect(meta.name).toBe("Moonshot(Kimi)");
    expect(meta.endpointVariants!.find((v) => v.id === "payg")!.baseUrl).toBe("https://api.moonshot.ai");
  });

  it("China entry defaults to Kimi Code, payg variant on api.moonshot.cn", () => {
    const meta = getProviderMeta("moonshot-cn")!;
    expect(meta).toBeDefined();
    expect(meta.defaultBaseUrl).toBe("https://api.kimi.com/coding");
    expect(meta.name).toBe("Moonshot(Kimi) China");
    expect(meta.endpointVariants!.find((v) => v.id === "payg")!.baseUrl).toBe("https://api.moonshot.cn");
  });

  it("both regions' pay-as-you-go variants expose the same Moonshot model list", () => {
    const intl = getProviderMeta("moonshot")!.endpointVariants!.find((v) => v.id === "payg")!.models!.map((m) => m.id);
    const cn = getProviderMeta("moonshot-cn")!.endpointVariants!.find((v) => v.id === "payg")!.models!.map((m) => m.id);
    expect(cn).toEqual(intl);
    expect(intl).toContain("kimi-k2.6");
    // Default (Kimi Code Plan) model list is the pinned single id for both.
    expect(getProviderMeta("moonshot")!.models.map((m) => m.id)).toEqual(["kimi-for-coding"]);
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

describe("maxOutputTokens (anthropic-wire, sourced from provider docs)", () => {
  const cases: Array<[string, string, number]> = [
    ["anthropic", "claude-opus-4-7", 128_000],
    ["anthropic", "claude-sonnet-4-6", 64_000],
    ["anthropic", "claude-haiku-4-5-20251001", 64_000],
    ["deepseek", "deepseek-v4-flash", 384_000],
    ["deepseek", "deepseek-v4-pro", 384_000],
    ["minimax", "MiniMax-M3", 524_288],
    ["minimax", "MiniMax-M2.7", 204_800],
    ["minimax", "MiniMax-M2", 204_800],
    ["mimo", "mimo-v2.5-pro", 131_072],
    ["mimo", "mimo-v2-flash", 65_536],
  ];
  it.each(cases)("%s/%s → %d", (provider, model, expected) => {
    expect(getModelMeta(provider as never, model)?.maxOutputTokens).toBe(expected);
  });

  it("stepfun flash models intentionally have no maxOutputTokens (官方未披露)", () => {
    expect(getModelMeta("stepfun" as never, "step-3.7-flash")?.maxOutputTokens).toBeUndefined();
    expect(getModelMeta("stepfun" as never, "step-3.5-flash")?.maxOutputTokens).toBeUndefined();
  });

  it("deepseek/minimax/mimo 每个模型都填了 maxOutputTokens", () => {
    for (const p of PROVIDER_REGISTRY) {
      if (p.id === "minimax" || p.id === "mimo" || p.id === "deepseek") {
        for (const m of p.models) {
          expect(m.maxOutputTokens, `${p.id}/${m.id}`).toBeTypeOf("number");
        }
      }
    }
  });
});

describe("endpoint variants", () => {
  it("zhipu defaults to Coding Plan; payg variant carries the pay-as-you-go base URL", () => {
    const meta = getProviderMeta("zhipu")!;
    expect(meta.defaultEndpointLabel).toBe("Coding Plan");
    expect(meta.defaultBaseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    const v = meta.endpointVariants?.find((x) => x.id === "payg");
    expect(v?.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(v?.models).toBeUndefined(); // 全量清单是超集，default 与 payg 都不 override
  });

  it("moonshot and moonshot-cn default to Kimi Code (pinned model); payg variant per region", () => {
    for (const id of ["moonshot", "moonshot-cn"] as const) {
      const meta = getProviderMeta(id)!;
      expect(meta.defaultBaseUrl).toBe("https://api.kimi.com/coding");
      expect(meta.defaultEndpointLabel).toBe("Kimi Code Plan");
      expect(meta.placeholder).toBe("sk-kimi-...");
      expect(meta.models.map((m) => m.id)).toEqual(["kimi-for-coding"]);
      const v = meta.endpointVariants?.find((x) => x.id === "payg");
      expect(v?.placeholder).toBe("sk-...");
      expect(v?.models?.map((m) => m.id)).toContain("kimi-k2.6");
    }
    expect(getProviderMeta("moonshot")!.endpointVariants![0]!.baseUrl).toBe("https://api.moonshot.ai");
    expect(getProviderMeta("moonshot-cn")!.endpointVariants![0]!.baseUrl).toBe("https://api.moonshot.cn");
  });

  it("mimo default stays the Token Plan endpoint; payg is the variant", () => {
    const meta = getProviderMeta("mimo")!;
    expect(meta.defaultBaseUrl).toBe("https://token-plan-cn.xiaomimimo.com");
    expect(meta.defaultEndpointLabel).toBe("Token Plan");
    expect(meta.placeholder).toBe("tp-...");
    const v = meta.endpointVariants?.find((x) => x.id === "payg");
    expect(v?.baseUrl).toBe("https://api.xiaomimimo.com");
    expect(v?.placeholder).toBe("sk-...");
    expect(v?.models).toBeUndefined();
  });

  it("stepfun defaults to Step Plan (base WITHOUT /v1, full pool); payg variant trims the pool", () => {
    const meta = getProviderMeta("stepfun")!;
    // SDK appends /v1/messages → default base must NOT carry /v1.
    expect(meta.defaultBaseUrl).toBe("https://api.stepfun.com/step_plan");
    expect(meta.defaultEndpointLabel).toBe("Step Plan");
    expect(meta.models.map((m) => m.id)).toEqual([
      "step-3.7-flash", "step-3.5-flash-2603", "step-3.5-flash", "step-router-v1",
    ]);
    const v = meta.endpointVariants?.find((x) => x.id === "payg");
    expect(v?.baseUrl).toBe("https://api.stepfun.com");
    expect(v?.models?.map((m) => m.id)).toEqual(["step-3.7-flash", "step-3.5-flash"]);
  });

  it("getModelMeta unions variant models after the default list", () => {
    expect(getModelMeta("moonshot", "kimi-for-coding")?.maxContextTokens).toBe(256_000); // default (Kimi Code)
    expect(getModelMeta("moonshot", "kimi-k2.6")).toBeDefined(); // payg variant → union hit
    expect(getModelMeta("stepfun", "step-router-v1")?.vision).toBe(false); // default (Step Plan)
    // 默认清单优先：step-3.7-flash 在默认清单与 payg variant 清单都存在 → 返回默认条目
    expect(getModelMeta("stepfun", "step-3.7-flash")?.vision).toBe(true);
  });

  it("resolveEndpointVariant: hit / miss / undefined", () => {
    const meta = getProviderMeta("zhipu")!;
    expect(resolveEndpointVariant(meta, "payg")?.id).toBe("payg");
    expect(resolveEndpointVariant(meta, "no-such")).toBeUndefined();
    expect(resolveEndpointVariant(meta, undefined)).toBeUndefined();
    expect(resolveEndpointVariant(getProviderMeta("anthropic")!, "payg")).toBeUndefined();
  });

  it("providers without variants are untouched", () => {
    for (const id of ["anthropic", "openai", "minimax", "deepseek", "gemini", "bailian", "openrouter"] as const) {
      expect(getProviderMeta(id)!.endpointVariants).toBeUndefined();
    }
  });

  it("every provider with endpointVariants has a defaultEndpointLabel and unique variant ids", () => {
    for (const p of PROVIDER_REGISTRY) {
      if (!p.endpointVariants?.length) continue;
      expect(p.defaultEndpointLabel, `${p.id} must label its default endpoint`).toBeTypeOf("string");
      expect(p.defaultEndpointLabel!.length, `${p.id} defaultEndpointLabel must be non-empty`).toBeGreaterThan(0);
      const ids = p.endpointVariants.map((v) => v.id);
      expect(new Set(ids).size, `${p.id} variant ids must be unique`).toBe(ids.length);
    }
  });

  it("every provider with variants uses the payg-as-variant convention (Plan is default)", () => {
    // The four flipped providers + mimo all model pay-as-you-go as the "payg"
    // variant, so the switch renders [Plan, Pay-as-you-go] uniformly.
    for (const id of ["zhipu", "moonshot", "moonshot-cn", "stepfun", "mimo"] as const) {
      const meta = getProviderMeta(id)!;
      expect(meta.endpointVariants!.some((v) => v.id === "payg"), `${id} must expose a payg variant`).toBe(true);
    }
  });
});
