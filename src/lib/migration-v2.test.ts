import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { migrateV1toV2 } from "./migration-v2";
import { getOrCreateEncryptionKey, encrypt, decrypt, _resetKeyForTests } from "./crypto";
import { _resetForTests } from "./idb/db";
import type { StoredInstance } from "./instances";

// NOTE: migrateV1toV2 is an upstream chrome.storage-domain migration — it reads
// V1 `provider_*` keys and writes `instance_*` / `instances_index` /
// `active_instance_id` into chrome.storage.local. It is NOT migrated to IDB, so
// assertions read the chrome.storage mock directly (the IDB-backed
// listInstances / getActiveInstance getters would not see what it writes).
function readStore<T>(key: string): T | undefined {
  return chromeMock.storage.local.__store[key] as T | undefined;
}

// Read every `instance_*` record the migration wrote into chrome.storage.
// Each StoredInstance already carries its own `id` field; fall back to the
// key suffix if a record ever omitted it.
function readStoredInstances(): Array<StoredInstance & { id: string }> {
  const store = chromeMock.storage.local.__store;
  return Object.keys(store)
    .filter((k) => k.startsWith("instance_"))
    .map((k) => {
      const rec = store[k] as StoredInstance;
      return { ...rec, id: rec.id ?? k.slice("instance_".length) };
    });
}

beforeEach(async () => {
  chromeMock.storage.local.__store = {};
  await _resetForTests();
  _resetKeyForTests();
});

async function seedV1(provider: string, apiKey: string, model: string, baseUrl?: string) {
  const key = await getOrCreateEncryptionKey();
  chromeMock.storage.local.__store[`provider_${provider}`] = {
    encryptedKey: await encrypt(apiKey, key),
    model,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

describe("migrateV1toV2", () => {
  it("converts each provider_* to instance_${uuid}; drops baseUrl; sets active", async () => {
    await seedV1("anthropic", "sk-ant-x", "claude-opus-4-7");
    await seedV1("openai", "sk-y", "gpt-4o", "https://my.proxy.example/v1");
    chromeMock.storage.local.__store["active_provider"] = "openai";

    await migrateV1toV2();

    const list = readStoredInstances();
    expect(list).toHaveLength(2);
    const openai = list.find((i) => i.provider === "openai")!;
    const key = await getOrCreateEncryptionKey();
    expect(await decrypt(openai.encryptedKey, key)).toBe("sk-y");
    expect(openai.customModels).toEqual(["gpt-4o"]); // V1 model preserved in customModels[0]
    // user's baseUrl override silently dropped
    expect(("baseUrl" in (openai as object))).toBe(false);

    expect(readStore<string>("active_instance_id")).toBe(openai.id);
    expect(chromeMock.storage.local.__store["schema_version"]).toBe(2);
    expect(chromeMock.storage.local.__store["migration_v2_mapping"]).toMatchObject({
      anthropic: expect.any(String),
      openai: openai.id,
    });
    // old keys cleaned up
    expect(chromeMock.storage.local.__store["provider_anthropic"]).toBeUndefined();
    expect(chromeMock.storage.local.__store["provider_openai"]).toBeUndefined();
    expect(chromeMock.storage.local.__store["active_provider"]).toBeUndefined();
  });

  it("idempotent: second call early-returns when schema_version=2", async () => {
    await seedV1("anthropic", "sk-ant-x", "claude-opus-4-7");
    await migrateV1toV2();
    const firstSnapshot = JSON.stringify(chromeMock.storage.local.__store);
    await migrateV1toV2();
    expect(JSON.stringify(chromeMock.storage.local.__store)).toBe(firstSnapshot);
  });

  it("model not in registry → goes into customModels[]", async () => {
    await seedV1("openai", "sk-y", "gpt-5-experimental");
    await migrateV1toV2();
    const list = readStoredInstances();
    const inst = list[0]!;
    expect(inst.customModels).toEqual(["gpt-5-experimental"]);
  });

  it("no v1 data: writes schema_version=2 and exits cleanly", async () => {
    await migrateV1toV2();
    expect(chromeMock.storage.local.__store["schema_version"]).toBe(2);
    expect(readStoredInstances()).toEqual([]);
  });
});
