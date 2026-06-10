import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests, STORES, tx, txMulti } from "@/lib/idb/db";
import { _resetKeyForTests, encrypt, getOrCreateEncryptionKey } from "@/lib/crypto";
import { getConfig } from "@/lib/idb/config-store";
import { getActiveInstance, getInstance, INDEX_KEY, listInstances, setActiveInstance } from "./instances";
import { migrateOneConfigPerProvider } from "./migrate-one-config-per-provider";
import type { StoredInstance } from "./instances";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("migrateOneConfigPerProvider", () => {
  it("keeps only the latest-created config for each duplicate provider", async () => {
    await seedStoredInstances([
      await stored("old-anthropic", "anthropic", 10, "old-key"),
      await stored("openai", "openai", 20, "openai-key"),
      await stored("new-anthropic", "anthropic", 30, "new-key"),
    ]);

    await migrateOneConfigPerProvider();

    expect((await listInstances()).map((i) => i.id)).toEqual(["openai", "new-anthropic"]);
    expect(await getInstance("old-anthropic")).toBeNull();
    expect((await getInstance("new-anthropic"))!.apiKey).toBe("new-key");
    expect(await getConfig<string[]>(INDEX_KEY)).toEqual(["openai", "new-anthropic"]);
  });

  it("moves active config to the kept latest config when active duplicate is deleted", async () => {
    await seedStoredInstances([
      await stored("old-openai", "openai", 10, "old-key"),
      await stored("new-openai", "openai", 20, "new-key"),
    ]);
    await setActiveInstance("old-openai");

    await migrateOneConfigPerProvider();

    expect(await getActiveInstance()).toBe("new-openai");
  });

  it("is idempotent when no duplicate providers exist", async () => {
    await seedStoredInstances([
      await stored("anthropic", "anthropic", 10, "ant-key"),
      await stored("openai", "openai", 20, "openai-key"),
    ]);

    await migrateOneConfigPerProvider();
    await migrateOneConfigPerProvider();

    expect((await listInstances()).map((i) => i.id)).toEqual(["anthropic", "openai"]);
  });
});

async function stored(
  id: string,
  provider: StoredInstance["provider"],
  createdAt: number,
  apiKey: string,
): Promise<StoredInstance> {
  const key = await getOrCreateEncryptionKey();
  return {
    id,
    provider,
    nickname: provider,
    encryptedKey: await encrypt(apiKey, key),
    createdAt,
  };
}

async function seedStoredInstances(instances: StoredInstance[]): Promise<void> {
  await txMulti([STORES.instances, STORES.config], "readwrite", (m) => {
    for (const inst of instances) m[STORES.instances].put(inst);
    m[STORES.config].put({ key: INDEX_KEY, value: instances.map((i) => i.id) });
  });
}
