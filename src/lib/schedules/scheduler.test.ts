// src/lib/schedules/scheduler.test.ts
//
// TDD tests for the chrome.alarms wrapper (Task 4.2). chrome.alarms is stubbed
// on globalThis so these run without a real extension runtime. runSchedule is
// injected (SchedulerDeps.runSchedule) so no real agent loop fires; the SW wires
// the real one. alarm name = "schedule:<id>".

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import type { ScheduleRecord } from "./types";

// ── chrome.alarms stub ────────────────────────────────────────────────────────

interface FakeAlarm {
  name: string;
  scheduledTime: number;
}

function installChromeStub() {
  const alarms = new Map<string, FakeAlarm>();
  const create = vi.fn((name: string, info: { when?: number; periodInMinutes?: number }) => {
    alarms.set(name, { name, scheduledTime: info.when ?? 0 });
  });
  const clear = vi.fn((name: string) => {
    const had = alarms.has(name);
    alarms.delete(name);
    return Promise.resolve(had);
  });
  const get = vi.fn((name: string) => Promise.resolve(alarms.get(name)));
  const onAlarm = { addListener: vi.fn() };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    alarms: { create, clear, get, onAlarm },
  };
  return { alarms, create, clear, get, onAlarm };
}

let stub: ReturnType<typeof installChromeStub>;

beforeEach(async () => {
  await _resetForTests();
  stub = installChromeStub();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSched(overrides: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
  const defaults: ScheduleRecord = {
    id: overrides.id,
    title: "Test",
    prompt: "do it",
    spec: { intervalMinutes: 60 },
    instanceId: "inst_1",
    enabled: true,
    status: "active",
    createdAt: 1000,
    runCount: 0,
    consecutiveFailures: 0,
    runIds: [],
  };
  return { ...defaults, ...overrides };
}

const NOW = Date.UTC(2026, 5, 12, 9, 0, 0);

// ── armSchedule ───────────────────────────────────────────────────────────────

describe("armSchedule", () => {
  it("scheduled (future startAt) → chrome.alarms.create({ when }) + patches nextRunAt", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { armSchedule } = await import("./scheduler");
    const future = NOW + 30 * 60_000;
    const rec = makeSched({ id: "sched_future", spec: { startAt: future, intervalMinutes: 60 } });
    await putSchedule(rec);
    const runSchedule = vi.fn(async () => {});

    await armSchedule(rec, { runSchedule, now: () => NOW });

    expect(stub.create).toHaveBeenCalledWith("schedule:sched_future", { when: future });
    // Did NOT dispatch a run immediately.
    expect(runSchedule).not.toHaveBeenCalled();
    // nextRunAt persisted.
    expect((await getSchedule("sched_future"))?.nextRunAt).toBe(future);
  });

  it("immediate (no startAt) → dispatches first run + patches nextRunAt=now (does NOT create an alarm)", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { armSchedule } = await import("./scheduler");
    const rec = makeSched({ id: "sched_now", spec: { intervalMinutes: 60 } });
    await putSchedule(rec);
    const runSchedule = vi.fn(async () => {});

    await armSchedule(rec, { runSchedule, now: () => NOW });

    expect(runSchedule).toHaveBeenCalledWith("sched_now");
    // No "when" alarm for the immediate first fire (it dispatches directly).
    expect(stub.create).not.toHaveBeenCalled();
    expect((await getSchedule("sched_now"))?.nextRunAt).toBe(NOW);
  });

  it("immediate when startAt is already in the past → dispatches now", async () => {
    const { putSchedule } = await import("./store");
    const { armSchedule } = await import("./scheduler");
    const past = NOW - 5 * 60_000;
    const rec = makeSched({ id: "sched_past", spec: { startAt: past, intervalMinutes: 60 } });
    await putSchedule(rec);
    const runSchedule = vi.fn(async () => {});

    await armSchedule(rec, { runSchedule, now: () => NOW });

    expect(runSchedule).toHaveBeenCalledWith("sched_past");
    expect(stub.create).not.toHaveBeenCalled();
  });

  it("fire-and-forget: armSchedule does not await runSchedule (a hanging run must not block)", async () => {
    const { putSchedule } = await import("./store");
    const { armSchedule } = await import("./scheduler");
    const rec = makeSched({ id: "sched_hang", spec: {} });
    await putSchedule(rec);
    // never-resolving runSchedule — if armSchedule awaited it, this would hang.
    const runSchedule = vi.fn(() => new Promise<void>(() => {}));

    await armSchedule(rec, { runSchedule, now: () => NOW });
    expect(runSchedule).toHaveBeenCalledWith("sched_hang");
  });
});

// ── disarmSchedule ────────────────────────────────────────────────────────────

describe("disarmSchedule", () => {
  it("clears the alarm for the schedule id", async () => {
    const { disarmSchedule } = await import("./scheduler");
    await disarmSchedule("sched_x");
    expect(stub.clear).toHaveBeenCalledWith("schedule:sched_x");
  });
});

// ── reconcileAlarms ───────────────────────────────────────────────────────────

describe("reconcileAlarms", () => {
  it("re-arms an active schedule whose nextRunAt is past and has no live alarm", async () => {
    const { putSchedule } = await import("./store");
    const { reconcileAlarms } = await import("./scheduler");
    const past = NOW - 10 * 60_000;
    await putSchedule(makeSched({ id: "sched_lost", status: "active", nextRunAt: past }));
    const runSchedule = vi.fn(async () => {});

    await reconcileAlarms(NOW, { runSchedule, now: () => NOW });

    // nextRunAt already past → re-armed immediately via dispatch (not create).
    expect(runSchedule).toHaveBeenCalledWith("sched_lost");
  });

  it("does NOT touch a schedule that already has a live alarm", async () => {
    const { putSchedule } = await import("./store");
    const { reconcileAlarms } = await import("./scheduler");
    const future = NOW + 60 * 60_000;
    await putSchedule(makeSched({ id: "sched_armed", status: "active", nextRunAt: future }));
    // Simulate an existing alarm.
    stub.alarms.set("schedule:sched_armed", { name: "schedule:sched_armed", scheduledTime: future });
    const runSchedule = vi.fn(async () => {});

    await reconcileAlarms(NOW, { runSchedule, now: () => NOW });

    expect(runSchedule).not.toHaveBeenCalled();
    expect(stub.create).not.toHaveBeenCalled();
  });

  it("re-creates a future alarm for an active schedule that lost its alarm", async () => {
    const { putSchedule } = await import("./store");
    const { reconcileAlarms } = await import("./scheduler");
    const future = NOW + 60 * 60_000;
    await putSchedule(makeSched({ id: "sched_refuture", status: "active", nextRunAt: future }));
    const runSchedule = vi.fn(async () => {});

    await reconcileAlarms(NOW, { runSchedule, now: () => NOW });

    // Future nextRunAt + no alarm → re-create the alarm (do not dispatch yet).
    expect(stub.create).toHaveBeenCalledWith("schedule:sched_refuture", { when: future });
    expect(runSchedule).not.toHaveBeenCalled();
  });

  it("ignores paused / completed schedules", async () => {
    const { putSchedule } = await import("./store");
    const { reconcileAlarms } = await import("./scheduler");
    const past = NOW - 10 * 60_000;
    await putSchedule(makeSched({ id: "sched_paused", status: "paused", nextRunAt: past }));
    await putSchedule(makeSched({ id: "sched_done", status: "completed", nextRunAt: past }));
    const runSchedule = vi.fn(async () => {});

    await reconcileAlarms(NOW, { runSchedule, now: () => NOW });

    expect(runSchedule).not.toHaveBeenCalled();
    expect(stub.create).not.toHaveBeenCalled();
  });

  // 9.1 — reconcile must respect `enabled`: a disabled (but still active)
  // schedule must NOT be re-armed or dispatched even if its alarm was lost.
  it("does NOT revive a disabled schedule (enabled=false), even if active + overdue", async () => {
    const { putSchedule } = await import("./store");
    const { reconcileAlarms } = await import("./scheduler");
    const past = NOW - 10 * 60_000;
    const future = NOW + 60 * 60_000;
    await putSchedule(makeSched({ id: "sched_dis_past", status: "active", enabled: false, nextRunAt: past }));
    await putSchedule(makeSched({ id: "sched_dis_future", status: "active", enabled: false, nextRunAt: future }));
    const runSchedule = vi.fn(async () => {});

    await reconcileAlarms(NOW, { runSchedule, now: () => NOW });

    expect(runSchedule).not.toHaveBeenCalled();
    expect(stub.create).not.toHaveBeenCalled();
  });
});

// ── handleAlarm ───────────────────────────────────────────────────────────────

describe("handleAlarm", () => {
  it("ignores non-schedule alarm names", async () => {
    const { handleAlarm } = await import("./scheduler");
    const runSchedule = vi.fn(async () => {});
    await handleAlarm("some-other-alarm", { runSchedule, now: () => NOW });
    expect(runSchedule).not.toHaveBeenCalled();
  });

  it("dispatches runSchedule and re-arms the next fire (recurring)", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { handleAlarm } = await import("./scheduler");
    // runCount 0 → after this run computeNextFireAt uses spec; anchor = nextRunAt.
    const anchor = NOW;
    await putSchedule(
      makeSched({ id: "sched_fire", status: "active", spec: { intervalMinutes: 60 }, nextRunAt: anchor, runCount: 0 }),
    );
    let resolveRun!: () => void;
    const runSchedule = vi.fn(() => new Promise<void>((r) => { resolveRun = () => r(); }));

    const p = handleAlarm("schedule:sched_fire", { runSchedule, now: () => NOW });
    // handleAlarm awaits getSchedule (anchor read) before dispatching the run,
    // so the call is visible after a microtask flush, not synchronously.
    await vi.waitFor(() => expect(runSchedule).toHaveBeenCalledWith("sched_fire"));
    resolveRun();
    await p;

    // Next alarm armed at anchor + 60m.
    expect(stub.create).toHaveBeenCalledWith("schedule:sched_fire", { when: anchor + 60 * 60_000 });
    expect((await getSchedule("sched_fire"))?.nextRunAt).toBe(anchor + 60 * 60_000);
  });

  it("disarms (no re-arm) for a one-shot schedule", async () => {
    const { putSchedule } = await import("./store");
    const { handleAlarm } = await import("./scheduler");
    await putSchedule(makeSched({ id: "sched_oneshot", status: "active", spec: {}, nextRunAt: NOW, runCount: 0 }));
    const runSchedule = vi.fn(async () => {});

    await handleAlarm("schedule:sched_oneshot", { runSchedule, now: () => NOW });

    expect(runSchedule).toHaveBeenCalledWith("sched_oneshot");
    // No further alarm created for a one-shot.
    expect(stub.create).not.toHaveBeenCalled();
  });

  it("no-ops when the schedule was deleted before the alarm fired", async () => {
    const { handleAlarm } = await import("./scheduler");
    const runSchedule = vi.fn(async () => {});
    await handleAlarm("schedule:sched_gone", { runSchedule, now: () => NOW });
    // runSchedule itself bails on missing schedule, but the wrapper should not throw.
    expect(stub.create).not.toHaveBeenCalled();
  });

  // 9.1 — a fired alarm for a disabled schedule must NOT dispatch a run nor
  // re-arm (defensive: even though toggle disarms, a stray alarm can't run it).
  it("does NOT dispatch or re-arm when the schedule is disabled (enabled=false)", async () => {
    const { putSchedule } = await import("./store");
    const { handleAlarm } = await import("./scheduler");
    await putSchedule(
      makeSched({ id: "sched_disfire", status: "active", enabled: false, spec: { intervalMinutes: 60 }, nextRunAt: NOW, runCount: 0 }),
    );
    const runSchedule = vi.fn(async () => {});

    await handleAlarm("schedule:sched_disfire", { runSchedule, now: () => NOW });

    expect(runSchedule).not.toHaveBeenCalled();
    expect(stub.create).not.toHaveBeenCalled();
    expect(stub.clear).toHaveBeenCalledWith("schedule:sched_disfire");
  });
});

// ── onAlarm startup-gate ordering (Issue 1) ───────────────────────────────────
//
// The SW's onAlarm listener gates handleAlarm behind scheduleStartupReady:
//   scheduleStartupReady.then(() => handleAlarm(name, deps))
// so the startup orphan-sweep + reconcile finish BEFORE any live alarm dispatches
// a run (orphan-sweep-before-dispatch holds for the live path, not just startup).
// We can't import the whole SW module (heavy chrome side effects at import), so we
// reproduce the exact gating composition here and assert the dispatch waits.

describe("onAlarm startup-gate ordering", () => {
  it("does not dispatch handleAlarm's run until the startup-ready gate resolves", async () => {
    const { putSchedule } = await import("./store");
    const { handleAlarm } = await import("./scheduler");
    await putSchedule(
      makeSched({ id: "sched_gate", status: "active", spec: { intervalMinutes: 60 }, nextRunAt: NOW, runCount: 0 }),
    );
    const runSchedule = vi.fn(async () => {});

    // A controllable gate standing in for scheduleStartupReady.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });

    // Exact SW composition: gate.then(() => handleAlarm(...)).
    const p = gate.then(() => handleAlarm("schedule:sched_gate", { runSchedule, now: () => NOW }));

    // Gate still closed → the run must NOT have been dispatched yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(runSchedule).not.toHaveBeenCalled();

    // Open the gate → now the run dispatches.
    openGate();
    await p;
    expect(runSchedule).toHaveBeenCalledWith("sched_gate");
  });
});
