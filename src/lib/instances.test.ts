import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import {
  createInstance, getInstance, listInstances, deleteInstance,
  setActiveInstance, getActiveInstance, resolveActiveInstanceModelConfig,
} from "./instances";

beforeEach(() => {
  chromeMock.storage.local.__store = {};
});

describe("instances CRUD", () => {
  it("createInstance writes encrypted, registers in instances_index, returns uuid", async () => {
    const id = await createInstance({
      provider: "anthropic",
      nickname: "Anthropic",
      apiKey: "sk-ant-secret",
      model: "claude-opus-4-7",
    });
    expect(id).toMatch(/^[0-9a-f]{8}-/);
    const stored = chromeMock.storage.local.__store[`instance_${id}`];
    expect(stored.encryptedKey).toBeDefined();
    expect(stored.encryptedKey).not.toContain("sk-ant-secret");
    const idx = chromeMock.storage.local.__store["instances_index"];
    expect(idx).toContain(id);
  });

  it("getInstance round-trips with decrypted apiKey", async () => {
    const id = await createInstance({ provider: "openai", nickname: "Work", apiKey: "sk-test", model: "gpt-4o" });
    const inst = await getInstance(id);
    expect(inst!.apiKey).toBe("sk-test");
    expect(inst!.provider).toBe("openai");
    expect(inst!.nickname).toBe("Work");
    expect(inst!.model).toBe("gpt-4o");
  });

  it("listInstances returns all registered, in instances_index order", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1", model: "claude-opus-4-7" });
    const b = await createInstance({ provider: "openai", nickname: "B", apiKey: "k2", model: "gpt-4o" });
    const list = await listInstances();
    expect(list.map((i) => i.id)).toEqual([a, b]);
  });

  it("deleteInstance removes storage + index entry; if active, picks next", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1", model: "claude-opus-4-7" });
    const b = await createInstance({ provider: "openai", nickname: "B", apiKey: "k2", model: "gpt-4o" });
    await setActiveInstance(a);
    await deleteInstance(a);
    expect(chromeMock.storage.local.__store[`instance_${a}`]).toBeUndefined();
    expect(chromeMock.storage.local.__store["instances_index"]).toEqual([b]);
    expect(await getActiveInstance()).toBe(b);
  });

  it("deleting last instance clears active_instance_id", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1", model: "claude-opus-4-7" });
    await setActiveInstance(a);
    await deleteInstance(a);
    expect(await getActiveInstance()).toBeNull();
  });

  it("resolveActiveInstanceModelConfig returns ModelConfig with resolved baseUrl", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "sk-test", model: "claude-opus-4-7" });
    await setActiveInstance(id);
    const cfg = await resolveActiveInstanceModelConfig();
    expect(cfg).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "sk-test",
      baseUrl: "https://api.anthropic.com",
    });
  });

  it("createInstance auto-pushes model to customModels when not in registry", async () => {
    const id = await createInstance({
      provider: "deepseek",
      nickname: "DS",
      apiKey: "sk-test",
      model: "deepseek-chat", // not in registry seed (only v4-flash, v4-pro)
    });
    const inst = await getInstance(id);
    expect(inst!.customModels).toEqual(["deepseek-chat"]);
  });

  it("createInstance respects explicit customModels and ensures selected model is included", async () => {
    const id = await createInstance({
      provider: "deepseek",
      nickname: "DS",
      apiKey: "sk-test",
      model: "deepseek-chat",
      customModels: ["deepseek-coder", "deepseek-chat"],
    });
    const inst = await getInstance(id);
    expect(inst!.customModels).toEqual(["deepseek-coder", "deepseek-chat"]);
  });

  it("createInstance with registry model leaves customModels undefined", async () => {
    const id = await createInstance({
      provider: "anthropic",
      nickname: "A",
      apiKey: "sk-test",
      model: "claude-opus-4-7", // in registry
    });
    const inst = await getInstance(id);
    expect(inst!.customModels).toBeUndefined();
  });
});
