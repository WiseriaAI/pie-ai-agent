import { describe, it, expect, beforeEach } from "vitest";
import { migrateV2toV3 } from "./migration-v3";
import { _resetForTests, tx, STORES } from "@/lib/idb/db";
import { getConfig } from "@/lib/idb/config-store";

beforeEach(async () => {
  await _resetForTests();
  await chrome.storage.local.clear();
});

describe("migrateV2toV3", () => {
  it("moves config, instance, and session records into IDB, then clears chrome.storage", async () => {
    await chrome.storage.local.set({
      "theme-mode": "dark",
      "instances_index": ["i1"],
      "instance_i1": { id: "i1", provider: "openai", nickname: "n", encryptedKey: "x", createdAt: 1 },
      "session_index": [{ id: "s1", title: "t", status: "active", lastAccessedAt: 1 }],
      "session_s1_meta": { id: "s1", title: "t", status: "active", lastAccessedAt: 1, createdAt: 1, messages: [] },
      "session_s1_agent": { agentMessages: [], pendingInstructions: [], stepIndex: 0 },
    });
    await migrateV2toV3();

    expect(await getConfig("theme-mode")).toBe("dark");
    expect(await getConfig("schema_version")).toBe(3);
    expect(await getConfig<string[]>("instances_index")).toEqual(["i1"]);
    // instance record in instances store
    const inst = await tx(STORES.instances, "readonly", (s) => s.get("i1"));
    expect((inst as any)?.id).toBe("i1");
    // session record under `${sid}:meta`
    const meta = await tx(STORES.sessions, "readonly", (s) => s.get("s1:meta"));
    expect((meta as any)?.value?.title).toBe("t");
    // index singleton
    const idx = await tx(STORES.sessionIndex, "readonly", (s) => s.get("index"));
    expect((idx as any)?.value?.length).toBe(1);
    // chrome.storage fully cleared
    const remaining = await chrome.storage.local.get(null);
    expect(Object.keys(remaining)).toHaveLength(0);
  });

  it("is idempotent: second run is a no-op (schema_version===3)", async () => {
    await chrome.storage.local.set({ "theme-mode": "light" });
    await migrateV2toV3();
    await chrome.storage.local.set({ "leftover": 1 });
    await migrateV2toV3();
    expect((await chrome.storage.local.get("leftover"))["leftover"]).toBe(1);
  });

  it("handles session ids containing underscores", async () => {
    await chrome.storage.local.set({
      "session_abc_def_meta": { id: "abc_def", title: "u" },
    });
    await migrateV2toV3();
    const meta = await tx(STORES.sessions, "readonly", (s) => s.get("abc_def:meta"));
    expect((meta as any)?.value?.title).toBe("u");
  });
});
