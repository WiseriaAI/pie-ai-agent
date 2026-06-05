import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { migrateInstanceModel } from "./migrate-instance-model";
import { getLastModelSelection } from "./last-model-selection";

// Seed a legacy V2 instance (with the old `model` field) directly into the
// in-memory store — migration only moves the stored record, it never decrypts.
function seed(id: string, provider: string, createdAt: number, model?: string) {
  chromeMock.storage.local.__store[`instance_${id}`] = {
    id,
    provider,
    nickname: id,
    encryptedKey: "enc",
    ...(model !== undefined ? { model } : {}),
    createdAt,
  };
}
function setIndex(ids: string[]) {
  chromeMock.storage.local.__store["instances_index"] = ids;
}
function indexNow(): string[] {
  return chromeMock.storage.local.__store["instances_index"] as string[];
}
function stored(id: string): Record<string, unknown> | undefined {
  return chromeMock.storage.local.__store[`instance_${id}`] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  chromeMock.storage.local.__store = {};
});

describe("migrateInstanceModel", () => {
  it("merges multiple instances of the same provider, keeping the active one", async () => {
    seed("i1", "openai", 100, "gpt-4o");
    seed("i2", "openai", 200, "gpt-4o-mini");
    seed("i3", "anthropic", 150, "claude-opus-4-7");
    setIndex(["i1", "i2", "i3"]);
    chromeMock.storage.local.__store["active_instance_id"] = "i1";

    await migrateInstanceModel();

    expect(indexNow().sort()).toEqual(["i1", "i3"]); // i2 dropped
    expect(stored("i2")).toBeUndefined();
    expect(stored("i1")!.model).toBeUndefined(); // model stripped
    expect(stored("i3")!.model).toBeUndefined();
  });

  it("seeds last_model_selection from the kept active instance's old model", async () => {
    seed("i1", "openai", 100, "gpt-4o");
    setIndex(["i1"]);
    chromeMock.storage.local.__store["active_instance_id"] = "i1";

    await migrateInstanceModel();

    expect(await getLastModelSelection()).toEqual({ instanceId: "i1", model: "gpt-4o" });
  });

  it("keeps newest by createdAt when no active is set", async () => {
    seed("i1", "openai", 100, "gpt-4o");
    seed("i2", "openai", 200, "gpt-4o-mini");
    setIndex(["i1", "i2"]);

    await migrateInstanceModel();

    expect(indexNow()).toEqual(["i2"]); // newest createdAt kept
    expect(stored("i1")).toBeUndefined();
  });

  it("is idempotent (second run is a no-op)", async () => {
    seed("i1", "openai", 100, "gpt-4o");
    seed("i2", "anthropic", 200, "claude-opus-4-7");
    setIndex(["i1", "i2"]);
    await migrateInstanceModel();
    const snapshot = JSON.stringify(chromeMock.storage.local.__store);
    await migrateInstanceModel();
    expect(JSON.stringify(chromeMock.storage.local.__store)).toBe(snapshot);
  });

  it("no-op when no instance has the legacy model field", async () => {
    seed("i1", "openai", 100); // no model
    setIndex(["i1"]);
    await migrateInstanceModel();
    expect(await getLastModelSelection()).toBeNull();
    expect(indexNow()).toEqual(["i1"]);
  });

  it("no-op when there are no instances", async () => {
    await migrateInstanceModel();
    expect(await getLastModelSelection()).toBeNull();
  });
});
