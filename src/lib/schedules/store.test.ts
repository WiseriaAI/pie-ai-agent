// src/lib/schedules/store.test.ts
//
// TDD tests for the schedules IDB store (DB_VERSION 3).

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import type { ScheduleRecord, ScheduleRunRecord } from "./types";
import { DEFAULT_RUN_HISTORY } from "./types";

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeSched(overrides: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
  const defaults: ScheduleRecord = {
    id: overrides.id,
    title: "Test schedule",
    prompt: "Do something useful",
    spec: { intervalMinutes: 60 },
    instanceId: "inst_abc",
    enabled: true,
    status: "active",
    createdAt: 1000,
    runCount: 0,
    consecutiveFailures: 0,
    runIds: [],
  };
  return { ...defaults, ...overrides };
}

function makeRun(overrides: Partial<ScheduleRunRecord> & { recordId: string }): ScheduleRunRecord {
  const defaults: ScheduleRunRecord = {
    recordId: overrides.recordId,
    scheduleId: "sched_test",
    runIndex: 1,
    startedAt: 1000,
    status: "running",
  };
  return { ...defaults, ...overrides };
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await _resetForTests();
});

// ── Step 2: DB version + store existence ─────────────────────────────────────

describe("DB_VERSION 3 + schedules store", () => {
  it("DB_VERSION 升到 3 且 schedules store 存在", async () => {
    const { openDb, STORES } = await import("@/lib/idb/db");
    const db = await openDb();
    expect(db.version).toBe(3);
    expect(db.objectStoreNames.contains(STORES.schedules)).toBe(true);
  });
});

// ── Step 3: CRUD ─────────────────────────────────────────────────────────────

describe("put/get/list/delete schedule", () => {
  it("put/get/list/delete schedule", async () => {
    const { putSchedule, getSchedule, listSchedules, deleteSchedule } = await import("./store");
    await putSchedule(makeSched({ id: "sched_a" }));
    expect((await getSchedule("sched_a"))?.id).toBe("sched_a");
    expect((await listSchedules()).map((s) => s.id)).toContain("sched_a");
    await deleteSchedule("sched_a");
    expect(await getSchedule("sched_a")).toBeNull();
  });

  it("listSchedules returns only sched_ records (not run_ keys)", async () => {
    const { putSchedule, listSchedules, appendRun } = await import("./store");
    await putSchedule(makeSched({ id: "sched_x" }));
    await appendRun("sched_x", makeRun({ recordId: "run_y", scheduleId: "sched_x" }));
    const list = await listSchedules();
    expect(list.every((r) => r.id.startsWith("sched_"))).toBe(true);
  });

  it("getSchedule returns null for unknown id", async () => {
    const { getSchedule } = await import("./store");
    expect(await getSchedule("sched_nonexistent")).toBeNull();
  });

  it("deleteSchedule cascade-deletes all referenced run records", async () => {
    const { putSchedule, appendRun, deleteSchedule, getRun, getSchedule } = await import("./store");
    await putSchedule(makeSched({ id: "sched_casc", runIds: [] }));
    await appendRun("sched_casc", makeRun({ recordId: "run_c1", scheduleId: "sched_casc", runIndex: 1 }));
    await appendRun("sched_casc", makeRun({ recordId: "run_c2", scheduleId: "sched_casc", runIndex: 2 }));
    await appendRun("sched_casc", makeRun({ recordId: "run_c3", scheduleId: "sched_casc", runIndex: 3 }));

    await deleteSchedule("sched_casc");

    expect(await getSchedule("sched_casc")).toBeNull();
    expect(await getRun("run_c1")).toBeNull();
    expect(await getRun("run_c2")).toBeNull();
    expect(await getRun("run_c3")).toBeNull();
  });
});

describe("appendRun circular buffer + getRun", () => {
  it("appendRun 环形保留最近 DEFAULT_RUN_HISTORY 条，挤出的 run 一并删除", async () => {
    const { putSchedule, appendRun, getSchedule, getRun } = await import("./store");
    await putSchedule(makeSched({ id: "sched_b", runIds: [] }));
    for (let i = 0; i < DEFAULT_RUN_HISTORY + 3; i++) {
      await appendRun("sched_b", makeRun({ recordId: `run_${i}`, scheduleId: "sched_b", runIndex: i + 1 }));
    }
    const s = await getSchedule("sched_b");
    expect(s!.runIds.length).toBe(DEFAULT_RUN_HISTORY);
    // Oldest runs evicted
    expect(await getRun("run_0")).toBeNull();
    expect(await getRun("run_1")).toBeNull();
    expect(await getRun("run_2")).toBeNull();
    // Newest run still present
    expect(await getRun(`run_${DEFAULT_RUN_HISTORY + 2}`)).not.toBeNull();
  });

  it("appendRun keeps runs in insertion order (oldest first in runIds)", async () => {
    const { putSchedule, appendRun, getSchedule } = await import("./store");
    await putSchedule(makeSched({ id: "sched_order", runIds: [] }));
    await appendRun("sched_order", makeRun({ recordId: "run_first", scheduleId: "sched_order", runIndex: 1 }));
    await appendRun("sched_order", makeRun({ recordId: "run_second", scheduleId: "sched_order", runIndex: 2 }));
    const s = await getSchedule("sched_order");
    expect(s!.runIds).toEqual(["run_first", "run_second"]);
  });

  it("getRun returns null for unknown recordId", async () => {
    const { getRun } = await import("./store");
    expect(await getRun("run_nonexistent")).toBeNull();
  });

  it("getRun returns a clean ScheduleRunRecord (no phantom `id` field)", async () => {
    const { putSchedule, appendRun, getRun } = await import("./store");
    await putSchedule(makeSched({ id: "sched_clean", runIds: [] }));
    await appendRun("sched_clean", makeRun({ recordId: "run_clean", scheduleId: "sched_clean", runIndex: 3 }));
    const run = await getRun("run_clean");
    expect(run).not.toBeNull();
    expect(Object.keys(run!)).not.toContain("id");
    expect(run!.recordId).toBe("run_clean");
    expect(run!.runIndex).toBe(3);
  });
});

describe("updateRun", () => {
  it("updateRun 局部更新 run 状态", async () => {
    const { putSchedule, appendRun, updateRun, getRun } = await import("./store");
    await putSchedule(makeSched({ id: "sched_c", runIds: [] }));
    await appendRun("sched_c", makeRun({ recordId: "run_x", scheduleId: "sched_c", status: "running" }));
    await updateRun("run_x", { status: "success", summary: "ok", endedAt: 2 });
    const run = await getRun("run_x");
    expect(run?.status).toBe("success");
    expect(run?.summary).toBe("ok");
    expect(run?.endedAt).toBe(2);
  });

  it("updateRun preserves unmodified fields", async () => {
    const { putSchedule, appendRun, updateRun, getRun } = await import("./store");
    await putSchedule(makeSched({ id: "sched_d", runIds: [] }));
    await appendRun("sched_d", makeRun({ recordId: "run_z", scheduleId: "sched_d", runIndex: 7, status: "running" }));
    await updateRun("run_z", { status: "failed", error: "timeout" });
    const run = await getRun("run_z");
    expect(run?.runIndex).toBe(7);
    expect(run?.scheduleId).toBe("sched_d");
  });

  it("updateRun is a no-op for unknown recordId (does not throw)", async () => {
    const { updateRun } = await import("./store");
    await expect(updateRun("run_unknown", { status: "success" })).resolves.not.toThrow();
  });
});

// ── Inner-get failure: must abort the transaction, never silently no-op ───────
//
// appendRun / updateRun / deleteSchedule each do a read-modify-write whose inner
// store.get(...) request carries an onerror handler. The outer txMulti only sees
// transaction-level errors, so without this inner onerror a failed get would let
// the transaction commit empty and the function resolve successfully — silently
// dropping the run / patch, or silently skipping the delete.
//
// We can't make fake-indexeddb produce a genuine async request error
// deterministically (the success-vs-commit ordering races), so we unit-test the
// wiring directly: stub get() to capture the onerror the production code
// assigns, let the call settle, then fire that captured onerror and assert it
// aborts the (spied) transaction. The txMulti abort→reject path itself is
// covered by txMulti's own tests.

describe("inner get failure aborts the transaction (does not silently no-op)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stub get() to be a no-op that captures the caller's onerror handler and the
   *  transaction it runs on (with abort spied). The synthetic request never
   *  settles on its own, so the transaction stays inert until the test fires the
   *  captured onerror — no commit/error race, no cross-file leak. */
  function captureGetHandlers(): {
    fireError: () => void;
    abortCalled: () => boolean;
    handlerAttached: () => boolean;
  } {
    let captured: ((this: IDBRequest, ev: Event) => void) | null = null;
    let req: IDBRequest | null = null;
    let aborted = false;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
      this: IDBObjectStore,
    ) {
      const txn = this.transaction as IDBTransaction & { __abortWrapped?: boolean };
      if (!txn.__abortWrapped) {
        const realAbort = txn.abort.bind(txn);
        txn.abort = () => {
          aborted = true;
          try {
            realAbort();
          } catch {
            /* transaction may already be settled in the test env — fine */
          }
        };
        txn.__abortWrapped = true;
      }
      const synthetic = {
        onsuccess: null,
        onerror: null,
        result: undefined,
        error: null,
        readyState: "pending",
        source: this,
        transaction: txn,
      } as unknown as IDBRequest;
      req = synthetic;
      return synthetic;
    });
    return {
      fireError: () => req?.onerror?.call(req, new Event("error")),
      abortCalled: () => aborted,
      handlerAttached: () => req?.onerror != null,
    };
  }

  it("appendRun assigns an inner onerror that aborts the transaction", async () => {
    const { putSchedule, appendRun } = await import("./store");
    await putSchedule(makeSched({ id: "sched_fail", runIds: [] }));
    const h = captureGetHandlers();
    // Hold + swallow the promise: firing onerror → abort() → txMulti rejects
    // (with null). We assert the abort wiring, not the rejection value.
    const p = appendRun("sched_fail", makeRun({ recordId: "run_f", scheduleId: "sched_fail" }))
      .catch(() => undefined);
    await Promise.resolve(); // let the store code attach its onerror
    expect(h.handlerAttached()).toBe(true);
    h.fireError();
    expect(h.abortCalled()).toBe(true);
    await p;
  });

  it("updateRun assigns an inner onerror that aborts the transaction", async () => {
    const { putSchedule, appendRun, updateRun } = await import("./store");
    await putSchedule(makeSched({ id: "sched_u", runIds: [] }));
    await appendRun("sched_u", makeRun({ recordId: "run_u", scheduleId: "sched_u" }));
    const h = captureGetHandlers();
    const p = updateRun("run_u", { status: "success" }).catch(() => undefined);
    await Promise.resolve();
    expect(h.handlerAttached()).toBe(true);
    h.fireError();
    expect(h.abortCalled()).toBe(true);
    await p;
  });

  it("deleteSchedule assigns an inner onerror that aborts the transaction", async () => {
    const { putSchedule, deleteSchedule } = await import("./store");
    await putSchedule(makeSched({ id: "sched_del", runIds: [] }));
    const h = captureGetHandlers();
    const p = deleteSchedule("sched_del").catch(() => undefined);
    await Promise.resolve();
    expect(h.handlerAttached()).toBe(true);
    h.fireError();
    expect(h.abortCalled()).toBe(true);
    await p;
  });
});
