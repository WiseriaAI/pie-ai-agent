import { describe, expect, it } from "vitest";
import { chromeMock } from "@/test/setup";
import { runSessionMigrations } from "./migration";
import { getSessionMeta, getSessionAgent, listSessionIndex } from "./storage";

// Helpers to seed 'default'-id residue directly into the mock store
function seedDefaultMeta(messages: unknown[] = []) {
  chromeMock.storage.local.__store["session_default_meta"] = {
    id: "default",
    createdAt: 1700000000000,
    lastAccessedAt: 1700000000000,
    status: "active",
    messages,
  };
}

function seedDefaultAgent(agentMessages: unknown[] = [], stepIndex = 0) {
  chromeMock.storage.local.__store["session_default_agent"] = {
    agentMessages,
    stepIndex,
    skillExecutionScopeStack: [],
  };
}

function seedDefaultIndex(extra: unknown[] = []) {
  chromeMock.storage.local.__store["session_index"] = [
    {
      id: "default",
      lastAccessedAt: 1700000000000,
      status: "active",
    },
    ...extra,
  ];
}

describe("runSessionMigrations", () => {
  it("(a) renames 'default' session to UUID — keys disappear, new UUID key appears, index updated", async () => {
    seedDefaultMeta([{ role: "user", content: "hello" }]);
    seedDefaultAgent([{ role: "user", content: "do it" }], 3);
    seedDefaultIndex();

    const result = await runSessionMigrations();

    // Old keys gone
    expect(chromeMock.storage.local.__store["session_default_meta"]).toBeUndefined();
    expect(chromeMock.storage.local.__store["session_default_agent"]).toBeUndefined();

    // Old index entry gone
    const index = await listSessionIndex();
    expect(index.find((e) => e.id === "default")).toBeUndefined();

    // New UUID entry present
    expect(index.length).toBe(1);
    const newEntry = index[0]!;
    expect(newEntry.id).not.toBe("default");
    expect(newEntry.id.length).toBeGreaterThan(10); // UUID format

    // Meta + agent accessible under new id
    const newMeta = await getSessionMeta(newEntry.id);
    expect(newMeta).not.toBeNull();
    expect(newMeta!.id).toBe(newEntry.id); // id field inside meta also updated
    expect(newMeta!.messages).toEqual([{ role: "user", content: "hello" }]);

    const newAgent = await getSessionAgent(newEntry.id);
    expect(newAgent).not.toBeNull();
    expect(newAgent!.stepIndex).toBe(3);

    // Result reports cleared keys
    expect(result.cleared).toContain("session_default_meta");
    expect(result.cleared).toContain("session_default_agent");
  });

  it("(b) no-op when no 'default' residue exists", async () => {
    // Seed a normal UUID session but no 'default' keys
    chromeMock.storage.local.__store["session_index"] = [
      { id: "abc-123", lastAccessedAt: 1700000000000, status: "active" },
    ];
    chromeMock.storage.local.__store["session_abc-123_meta"] = {
      id: "abc-123",
      createdAt: 1700000000000,
      lastAccessedAt: 1700000000000,
      status: "active",
      messages: [],
    };

    const result = await runSessionMigrations();

    // Untouched
    expect(chromeMock.storage.local.__store["session_abc-123_meta"]).toBeDefined();
    expect(result.cleared).toHaveLength(0);
  });

  it("(c) idempotent — second run after migration is no-op", async () => {
    seedDefaultMeta([{ role: "user", content: "hello" }]);
    seedDefaultAgent();
    seedDefaultIndex();

    const r1 = await runSessionMigrations();
    expect(r1.cleared.length).toBeGreaterThan(0);

    // Second run: 'default' keys are already gone
    const r2 = await runSessionMigrations();
    expect(r2.cleared).toHaveLength(0);
  });

  it("(a2) drops empty 'default' session without creating a UUID entry", async () => {
    // Empty messages + zero stepIndex = nothing meaningful to preserve
    seedDefaultMeta([]); // empty messages
    seedDefaultAgent([], 0); // empty agent
    seedDefaultIndex();

    const result = await runSessionMigrations();

    // Old keys gone
    expect(chromeMock.storage.local.__store["session_default_meta"]).toBeUndefined();
    expect(chromeMock.storage.local.__store["session_default_agent"]).toBeUndefined();

    // Index no longer contains 'default'
    const index = await listSessionIndex();
    expect(index.find((e) => e.id === "default")).toBeUndefined();

    // No new UUID session created — empty sessions are just dropped
    expect(index.length).toBe(0);

    expect(result.cleared).toContain("session_default_meta");
  });

  it("(d) preserves non-default index entries during rename", async () => {
    seedDefaultMeta([{ role: "user", content: "hi" }]);
    seedDefaultAgent();
    // Index has 'default' + one real session
    chromeMock.storage.local.__store["session_index"] = [
      { id: "default", lastAccessedAt: 1700000000000, status: "active" },
      { id: "real-uuid-1", lastAccessedAt: 1700000000001, status: "active" },
    ];

    await runSessionMigrations();

    const index = await listSessionIndex();
    // 'default' gone, real-uuid-1 preserved, new UUID added
    expect(index.find((e) => e.id === "default")).toBeUndefined();
    expect(index.find((e) => e.id === "real-uuid-1")).toBeDefined();
    expect(index.length).toBe(2); // real-uuid-1 + renamed default
  });
});
