import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { getConfig } from "@/lib/idb/config-store";
import { _resetKeyForTests } from "@/lib/crypto";
import {
  createInstance, getInstance, listInstances, deleteInstance,
  setActiveInstance, getActiveInstance, resolveActiveInstanceModelConfig,
  resolveModelConfig, firstModelForProvider, updateInstance,
  INDEX_KEY,
} from "./instances";
import { saveCustomProvider } from "./custom-providers";
import { setProviderCustomModelMeta } from "./provider-custom-model-meta";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("instances CRUD", () => {
  it("createInstance writes encrypted, registers in instances_index, returns uuid", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "Anthropic", apiKey: "sk-ant-secret" });
    expect(id).toMatch(/^[0-9a-f]{8}-/);
    // Verify via the public API (IDB-backed)
    const inst = await getInstance(id);
    expect(inst).not.toBeNull();
    expect(inst!.apiKey).toBe("sk-ant-secret"); // round-trips correctly
    expect((inst as unknown as { encryptedKey?: string }).encryptedKey).toBeUndefined(); // not exposed raw
    expect((inst as unknown as { model?: string }).model).toBeUndefined(); // model decoupled from instance
    // Verify index contains the new id
    const idx = await getConfig<string[]>(INDEX_KEY);
    expect(idx).toContain(id);
  });

  it("createInstance commits instance record + index atomically (D9)", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    // After the single txMulti commits, both the record and the index entry
    // must be visible together (no orphan instance missing from the index).
    expect(await getInstance(id)).not.toBeNull();
    expect(await getConfig<string[]>(INDEX_KEY)).toContain(id);
    // And it must show up via the index-driven listing.
    expect((await listInstances()).map((i) => i.id)).toContain(id);
  });

  it("getInstance round-trips with decrypted apiKey (no model field)", async () => {
    const id = await createInstance({ provider: "openai", nickname: "Work", apiKey: "sk-test" });
    const inst = await getInstance(id);
    expect(inst!.apiKey).toBe("sk-test");
    expect(inst!.provider).toBe("openai");
    expect(inst!.nickname).toBe("Work");
    expect((inst as unknown as { model?: string }).model).toBeUndefined();
  });

  it("listInstances returns all registered, in instances_index order", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1" });
    const b = await createInstance({ provider: "openai", nickname: "B", apiKey: "k2" });
    const list = await listInstances();
    expect(list.map((i) => i.id)).toEqual([a, b]);
  });

  it("deleteInstance removes instance record + index atomically (D9)", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1" });
    const b = await createInstance({ provider: "openai", nickname: "B", apiKey: "k2" });
    await deleteInstance(a);
    // After the single txMulti commits, both the record and the index entry
    // must be gone together (no dangling index entry pointing at a deleted record).
    expect(await getInstance(a)).toBeNull();
    const idx = await getConfig<string[]>(INDEX_KEY);
    expect(idx).not.toContain(a);
    expect(idx).toContain(b);
  });

  it("deleteInstance removes storage + index entry; if active, picks next", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1" });
    const b = await createInstance({ provider: "openai", nickname: "B", apiKey: "k2" });
    await setActiveInstance(a);
    await deleteInstance(a);
    // Verify instance no longer accessible
    expect(await getInstance(a)).toBeNull();
    // Verify index updated
    const idx = await getConfig<string[]>(INDEX_KEY);
    expect(idx).toEqual([b]);
    expect(await getActiveInstance()).toBe(b);
  });

  it("deleting last instance clears active_instance_id", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1" });
    await setActiveInstance(a);
    await deleteInstance(a);
    expect(await getActiveInstance()).toBeNull();
  });

  it("createInstance stores explicit customModels", async () => {
    const id = await createInstance({ provider: "deepseek", nickname: "DS", apiKey: "sk-test", customModels: ["deepseek-coder", "deepseek-chat"] });
    const inst = await getInstance(id);
    expect(inst!.customModels).toEqual(["deepseek-coder", "deepseek-chat"]);
  });

  it("createInstance without customModels leaves it undefined", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "sk-test" });
    const inst = await getInstance(id);
    expect(inst!.customModels).toBeUndefined();
  });

  it("createInstance rejects a second config for the same provider", async () => {
    await createInstance({ provider: "anthropic", nickname: "A", apiKey: "sk-ant-a" });
    await expect(
      createInstance({ provider: "anthropic", nickname: "A2", apiKey: "sk-ant-b" }),
    ).rejects.toThrow(/already has a config/i);
  });
});

describe("firstModelForProvider", () => {
  it("returns registry[0] for a provider with no customModels", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    expect(await firstModelForProvider("anthropic", id)).toBe("claude-opus-4-7");
  });

  it("prefers instance.customModels[0] when present", async () => {
    const id = await createInstance({ provider: "openai", nickname: "O", apiKey: "k", customModels: ["my-ft"] });
    expect(await firstModelForProvider("openai", id)).toBe("my-ft");
  });

  it("falls back to fetched[0] for lazy provider with no registry/custom", async () => {
    const id = await createInstance({ provider: "openrouter", nickname: "OR", apiKey: "k" });
    await updateInstance(id, { fetchedModels: [{ id: "x/y", vision: false, tools: true, maxContextTokens: 8000 }] });
    expect(await firstModelForProvider("openrouter", id)).toBe("x/y");
  });
});

describe("resolveActiveInstanceModelConfig", () => {
  it("returns ModelConfig with resolved baseUrl + provider's first model", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "sk-test" });
    await setActiveInstance(id);
    const cfg = await resolveActiveInstanceModelConfig();
    expect(cfg).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "sk-test",
      baseUrl: "https://api.anthropic.com",
    });
  });
});

// Issue #35 / #39 regression — vision capability is per-model, resolved at
// task start so the screenshot guard (loop.ts) acts on the right model.
describe("resolveModelConfig — vision per model (#35 / #39)", () => {
  it("registry vision-capable model: vision === true", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "claude-opus-4-7");
    expect(cfg!.vision).toBe(true);
  });

  it("registry text-only model: vision === false (guard correctly fires)", async () => {
    const id = await createInstance({ provider: "openai", nickname: "O", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "o3-mini");
    expect(cfg!.vision).toBe(false);
  });

  it("OpenRouter (registry empty) with fetchedModels: vision from per-instance fetch", async () => {
    const id = await createInstance({ provider: "openrouter", nickname: "OR", apiKey: "k", customModels: ["anthropic/claude-sonnet-4"] });
    await updateInstance(id, {
      fetchedModels: [
        { id: "anthropic/claude-sonnet-4", vision: true, tools: true, maxContextTokens: 200_000 },
        { id: "meta-llama/llama-3-70b", vision: false, tools: true, maxContextTokens: 8_000 },
      ],
      fetchedAt: Date.now(),
    });
    const cfg = await resolveModelConfig(id, "anthropic/claude-sonnet-4");
    expect(cfg!.vision).toBe(true);
  });

  it("OpenRouter without fetchedModels: vision undefined (loop guard fail-opens)", async () => {
    const id = await createInstance({ provider: "openrouter", nickname: "OR", apiKey: "k", customModels: ["anthropic/claude-sonnet-4"] });
    const cfg = await resolveModelConfig(id, "anthropic/claude-sonnet-4");
    expect(cfg!.vision).toBeUndefined();
  });

  describe("custom provider vision wired from CustomModelMeta (#62)", () => {
    it("custom vision-capable model: vision === true", async () => {
      const cpId = await saveCustomProvider({
        name: "MyLLM", baseUrl: "https://api.myllm.test/v1",
        models: [
          { id: "vlm-1", vision: true, tools: true, maxContextTokens: 128_000 },
          { id: "text-1", vision: false, tools: true, maxContextTokens: 128_000 },
        ],
      });
      const id = await createInstance({ provider: `custom:${cpId}`, nickname: "Custom", apiKey: "k" });
      const cfg = await resolveModelConfig(id, "vlm-1");
      expect(cfg!.vision).toBe(true);
    });

    it("custom text-only model: vision === false", async () => {
      const cpId = await saveCustomProvider({
        name: "MyLLM", baseUrl: "https://api.myllm.test/v1",
        models: [{ id: "text-1", vision: false, tools: true, maxContextTokens: 128_000 }],
      });
      const id = await createInstance({ provider: `custom:${cpId}`, nickname: "Custom", apiKey: "k" });
      const cfg = await resolveModelConfig(id, "text-1");
      expect(cfg!.vision).toBe(false);
    });

    it("custom model id not in provider's model list: vision undefined (fail-closed)", async () => {
      const cpId = await saveCustomProvider({
        name: "MyLLM", baseUrl: "https://api.myllm.test/v1",
        models: [{ id: "text-1", vision: false, tools: true, maxContextTokens: 128_000 }],
      });
      const id = await createInstance({ provider: `custom:${cpId}`, nickname: "Custom", apiKey: "k" });
      const cfg = await resolveModelConfig(id, "ghost-model");
      expect(cfg!.vision).toBeUndefined();
    });
  });
});

describe("resolveModelConfig — builtin custom model vision via pcmm", () => {
  it("pcmm vision:true unlocks vision for a non-registry builtin model", async () => {
    const id = await createInstance({ provider: "minimax", nickname: "X", apiKey: "k", customModels: ["MyVisionModel"] });
    await setProviderCustomModelMeta("minimax", "MyVisionModel", { vision: true, maxContextTokens: 256_000 });
    const cfg = await resolveModelConfig(id, "MyVisionModel");
    expect(cfg?.vision).toBe(true);
  });

  it("pcmm vision:false sets vision false (present, not omitted)", async () => {
    const id = await createInstance({ provider: "minimax", nickname: "X", apiKey: "k", customModels: ["MyTextModel"] });
    await setProviderCustomModelMeta("minimax", "MyTextModel", { vision: false, maxContextTokens: 256_000 });
    const cfg = await resolveModelConfig(id, "MyTextModel");
    expect(cfg?.vision).toBe(false);
  });

  it("registry preset still wins (MiniMax-M3 vision true) without pcmm", async () => {
    const id = await createInstance({ provider: "minimax", nickname: "X", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "MiniMax-M3");
    expect(cfg?.vision).toBe(true);
  });

  it("unknown builtin model with no pcmm omits vision (undefined → fail-closed)", async () => {
    const id = await createInstance({ provider: "minimax", nickname: "X", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "no-such-model");
    expect(cfg && "vision" in cfg).toBe(false);
  });
});

describe("resolveModelConfig — maxOutputTokens resolved from registry", () => {
  it("anthropic-wire registry model carries its maxOutputTokens", async () => {
    const id = await createInstance({ provider: "deepseek", nickname: "DS", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "deepseek-v4-flash");
    expect(cfg!.maxOutputTokens).toBe(384_000);
  });

  it("registry model without maxOutputTokens leaves it undefined", async () => {
    const id = await createInstance({ provider: "stepfun", nickname: "SF", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "step-3.7-flash");
    expect(cfg!.maxOutputTokens).toBeUndefined();
  });

  it("instance-level maxTokens coexists with resolved maxOutputTokens (neither overwrites)", async () => {
    const id = await createInstance({ provider: "deepseek", nickname: "DS", apiKey: "k" });
    await updateInstance(id, { maxTokens: 8000 });
    const cfg = await resolveModelConfig(id, "deepseek-v4-flash");
    expect(cfg!.maxTokens).toBe(8000);
    expect(cfg!.maxOutputTokens).toBe(384_000);
  });
});

describe("endpoint variants", () => {
  it("endpointVariant round-trips through create/get and survives unrelated updates", async () => {
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k", endpointVariant: "payg" });
    expect((await getInstance(id))!.endpointVariant).toBe("payg");
    await updateInstance(id, { nickname: "Z2" });
    expect((await getInstance(id))!.endpointVariant).toBe("payg");
  });

  it("updateInstance: string sets, null clears back to default endpoint", async () => {
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k" });
    await updateInstance(id, { endpointVariant: "payg" });
    expect((await getInstance(id))!.endpointVariant).toBe("payg");
    await updateInstance(id, { endpointVariant: null });
    expect((await getInstance(id))!.endpointVariant).toBeUndefined();
  });

  it("resolveModelConfig: no variant → default (Plan) baseUrl", async () => {
    // Default endpoint is now the Coding Plan; pay-as-you-go is the variant.
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "glm-4.7");
    expect(cfg!.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
  });

  it("resolveModelConfig: payg variant overrides baseUrl + model meta (union lookup)", async () => {
    const id = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k", endpointVariant: "payg" });
    const cfg = await resolveModelConfig(id, "kimi-k2.6");
    expect(cfg!.baseUrl).toBe("https://api.moonshot.ai"); // pay-as-you-go endpoint
    expect(cfg!.vision).toBe(true); // kimi-k2.6 lives in the payg variant pool, vision:true
  });

  it("resolveModelConfig: dangling variant id falls back to the default (Plan) baseUrl", async () => {
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k", endpointVariant: "removed-variant" });
    const cfg = await resolveModelConfig(id, "glm-4.7");
    expect(cfg!.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
  });

  it("firstModelForProvider prefers the variant pool over the registry list", async () => {
    // payg variant → its own pool head (kimi-k2.6)
    const id = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k", endpointVariant: "payg" });
    expect(await firstModelForProvider("moonshot", id)).toBe("kimi-k2.6");
    // 无 variant 的 instance 取默认（Plan）registry[0] = kimi-for-coding
    await updateInstance(id, { endpointVariant: null });
    expect(await firstModelForProvider("moonshot", id)).toBe("kimi-for-coding");
    // customModels 仍最优先
    await updateInstance(id, { endpointVariant: "payg", customModels: ["my-model"] });
    expect(await firstModelForProvider("moonshot", id)).toBe("my-model");
  });

  it("firstModelForProvider: variantOverride null forces the default (Plan) pool over the stored variant", async () => {
    // 存量 instance 选了 payg，但表单已切回默认端点（payload.endpointVariant=undefined → null）
    const id = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k", endpointVariant: "payg" });
    expect(await firstModelForProvider("moonshot", id, null)).toBe("kimi-for-coding");
  });

  it("firstModelForProvider: variantOverride string resolves that variant regardless of stored field", async () => {
    // 存量 instance 无 variant（默认 Plan），表单里选了 payg（尚未保存）
    const id = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k" });
    expect(await firstModelForProvider("moonshot", id, "payg")).toBe("kimi-k2.6");
  });

  it("updateInstance: empty string also clears (same hygiene as create's conditional spread)", async () => {
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k", endpointVariant: "payg" });
    await updateInstance(id, { endpointVariant: "" });
    expect((await getInstance(id))!.endpointVariant).toBeUndefined();
  });

  it("firstModelForProvider without instanceId picks the provider's instance and honours its variant", async () => {
    await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k", endpointVariant: "payg" });
    expect(await firstModelForProvider("moonshot")).toBe("kimi-k2.6");
  });

  it("resolveModelConfig: custom provider with dangling endpointVariant falls back to cp.baseUrl", async () => {
    const cpId = await saveCustomProvider({
      name: "MyLLM", baseUrl: "https://api.myllm.test/v1",
      models: [{ id: "text-1", vision: false, tools: true, maxContextTokens: 128_000 }],
    });
    const id = await createInstance({ provider: `custom:${cpId}`, nickname: "Custom", apiKey: "k", endpointVariant: "ghost-variant" });
    const cfg = await resolveModelConfig(id, "text-1");
    expect(cfg!.baseUrl).toBe("https://api.myllm.test/v1");
  });
});
