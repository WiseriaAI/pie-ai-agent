import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { migrateV1toV2 } from "./migration-v2";
import { listInstances, getActiveInstance } from "./instances";
import { getOrCreateEncryptionKey, encrypt } from "./crypto";

beforeEach(() => {
  chromeMock.storage.local.__store = {};
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

    const list = await listInstances();
    expect(list).toHaveLength(2);
    const openai = list.find((i) => i.provider === "openai")!;
    expect(openai.apiKey).toBe("sk-y");
    expect(openai.customModels).toEqual(["gpt-4o"]); // V1 model preserved in customModels[0]
    // user's baseUrl override silently dropped
    expect(("baseUrl" in (openai as object))).toBe(false);

    expect(await getActiveInstance()).toBe(openai.id);
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
    const list = await listInstances();
    const inst = list[0]!;
    expect(inst.customModels).toEqual(["gpt-5-experimental"]);
  });

  it("no v1 data: writes schema_version=2 and exits cleanly", async () => {
    await migrateV1toV2();
    expect(chromeMock.storage.local.__store["schema_version"]).toBe(2);
    expect(await listInstances()).toEqual([]);
  });
});
