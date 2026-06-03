import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import {
  saveCustomProvider,
  getCustomProvider,
  addCustomProviderModel,
  updateCustomProviderModel,
  removeCustomProviderModel,
  type CustomModelMeta,
} from "./custom-providers";

beforeEach(() => {
  chromeMock.storage.local.__store = {};
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
