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
