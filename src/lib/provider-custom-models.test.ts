import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import {
  getProviderCustomModels,
  addProviderCustomModel,
  removeProviderCustomModel,
} from "./provider-custom-models";

beforeEach(async () => {
  await _resetForTests();
});

describe("provider-custom-models", () => {
  it("getProviderCustomModels returns [] when nothing stored", async () => {
    expect(await getProviderCustomModels("anthropic")).toEqual([]);
  });

  it("addProviderCustomModel persists + dedupes", async () => {
    await addProviderCustomModel("openrouter", "model-a");
    await addProviderCustomModel("openrouter", "model-b");
    await addProviderCustomModel("openrouter", "model-a"); // dup
    expect(await getProviderCustomModels("openrouter")).toEqual(["model-a", "model-b"]);
  });

  it("addProviderCustomModel ignores empty / whitespace-only ids", async () => {
    await addProviderCustomModel("openrouter", "");
    await addProviderCustomModel("openrouter", "   ");
    expect(await getProviderCustomModels("openrouter")).toEqual([]);
  });

  it("addProviderCustomModel trims whitespace", async () => {
    await addProviderCustomModel("openrouter", "  spaced-id  ");
    expect(await getProviderCustomModels("openrouter")).toEqual(["spaced-id"]);
  });

  it("removeProviderCustomModel filters and persists", async () => {
    await addProviderCustomModel("anthropic", "alpha");
    await addProviderCustomModel("anthropic", "beta");
    await removeProviderCustomModel("anthropic", "alpha");
    expect(await getProviderCustomModels("anthropic")).toEqual(["beta"]);
  });

  it("removeProviderCustomModel is no-op for missing id", async () => {
    await addProviderCustomModel("anthropic", "alpha");
    await removeProviderCustomModel("anthropic", "ghost");
    expect(await getProviderCustomModels("anthropic")).toEqual(["alpha"]);
  });

  it("provider pools are isolated by provider", async () => {
    await addProviderCustomModel("openai", "x");
    await addProviderCustomModel("anthropic", "y");
    expect(await getProviderCustomModels("openai")).toEqual(["x"]);
    expect(await getProviderCustomModels("anthropic")).toEqual(["y"]);
  });
});
