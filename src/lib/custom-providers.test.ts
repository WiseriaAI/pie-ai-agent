import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { getConfig } from "@/lib/idb/config-store";
import { createInstance } from "@/lib/instances";
import {
  saveCustomProvider,
  getCustomProvider,
  listCustomProviders,
  addCustomProviderModel,
  updateCustomProviderModel,
  removeCustomProviderModel,
  getInstancesUsingCustomProvider,
  deleteCustomProvider,
  CUSTOM_PREFIX,
  type CustomModelMeta,
} from "./custom-providers";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

const meta = (id: string, over: Partial<CustomModelMeta> = {}): CustomModelMeta => ({
  id,
  displayName: undefined,
  vision: false,
  tools: true,
  maxContextTokens: 256_000,
  ...over,
});

describe("custom provider model helpers", () => {
  it("addCustomProviderModel appends a model to the provider entity", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    await addCustomProviderModel(id, meta("gpt-4o", { vision: true }));
    const cp = await getCustomProvider(id);
    expect(cp!.models.map((m) => m.id)).toEqual(["gpt-4o"]);
    expect(cp!.models[0].vision).toBe(true);
    expect(cp!.models[0].tools).toBe(true);
  });

  it("addCustomProviderModel is idempotent on duplicate id (does not overwrite)", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [meta("a")] });
    await addCustomProviderModel(id, meta("a", { vision: true }));
    const cp = await getCustomProvider(id);
    expect(cp!.models).toHaveLength(1);
    expect(cp!.models[0].vision).toBe(false);
  });

  it("updateCustomProviderModel replaces meta for matching id, preserves id + order", async () => {
    const id = await saveCustomProvider({
      name: "X",
      baseUrl: "https://x.ai/v1",
      models: [meta("a"), meta("b")],
    });
    await updateCustomProviderModel(id, "a", meta("a", { vision: true, maxContextTokens: 8000 }));
    const cp = await getCustomProvider(id);
    const a = cp!.models.find((m) => m.id === "a")!;
    expect(a.vision).toBe(true);
    expect(a.maxContextTokens).toBe(8000);
    expect(cp!.models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("updateCustomProviderModel no-ops when id absent", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [meta("a")] });
    await updateCustomProviderModel(id, "ghost", meta("ghost"));
    const cp = await getCustomProvider(id);
    expect(cp!.models.map((m) => m.id)).toEqual(["a"]);
  });

  it("removeCustomProviderModel drops the matching model", async () => {
    const id = await saveCustomProvider({
      name: "X",
      baseUrl: "https://x.ai/v1",
      models: [meta("a"), meta("b")],
    });
    await removeCustomProviderModel(id, "a");
    const cp = await getCustomProvider(id);
    expect(cp!.models.map((m) => m.id)).toEqual(["b"]);
  });

  it("addCustomProviderModel throws for unknown provider", async () => {
    await expect(addCustomProviderModel("nope", meta("a"))).rejects.toThrow();
  });
});

describe("custom provider CRUD + persistence (IDB config store)", () => {
  it("saveCustomProvider writes entity and index atomically (both visible)", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1/", models: [meta("a")] });
    // index visible
    const idx = await getConfig<string[]>("custom_providers_index");
    expect(idx).toEqual([id]);
    // entity visible at config key
    const entity = await getConfig<{ id: string; baseUrl: string }>(`custom_provider_${id}`);
    expect(entity!.id).toBe(id);
    // trailing slash trimmed
    expect(entity!.baseUrl).toBe("https://x.ai/v1");
    // and via the public getter
    const cp = await getCustomProvider(id);
    expect(cp!.name).toBe("X");
  });

  it("listCustomProviders returns all saved providers in index order", async () => {
    const a = await saveCustomProvider({ name: "A", baseUrl: "https://a/v1", models: [] });
    const b = await saveCustomProvider({ name: "B", baseUrl: "https://b/v1", models: [] });
    const all = await listCustomProviders();
    expect(all.map((p) => p.id)).toEqual([a, b]);
  });

  it("getCustomProvider returns null for unknown id", async () => {
    expect(await getCustomProvider("nope")).toBeNull();
  });

  it("deleteCustomProvider removes entity + index entry when unreferenced", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    await deleteCustomProvider(id);
    expect(await getCustomProvider(id)).toBeNull();
    expect(await getConfig<string[]>("custom_providers_index")).toEqual([]);
    expect(await getConfig(`custom_provider_${id}`)).toBeUndefined();
  });
});

describe("instance reference checks (via listInstances)", () => {
  it("getInstancesUsingCustomProvider finds instances whose provider is custom:<id>", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    const iid = await createInstance({
      provider: `${CUSTOM_PREFIX}${id}`,
      nickname: "my-inst",
      apiKey: "sk-123",
    });
    // an unrelated instance on a builtin provider
    await createInstance({ provider: "openai", nickname: "other", apiKey: "sk-999" });

    const refs = await getInstancesUsingCustomProvider(id);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(iid);
    expect(refs[0].nickname).toBe("my-inst");
  });

  it("deleteCustomProvider throws when a referencing instance exists", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    await createInstance({ provider: `${CUSTOM_PREFIX}${id}`, nickname: "i", apiKey: "sk-1" });
    await expect(deleteCustomProvider(id)).rejects.toThrow(/still reference it/);
    // entity untouched
    expect(await getCustomProvider(id)).not.toBeNull();
  });
});
