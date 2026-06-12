// src/lib/schedules/schedule-ops.test.ts
//
// Task 9 — shared schedule-ops core. The single source of truth for the
// create / update / delete / toggle / run-now operations, called by BOTH the
// schedule-meta agent tools AND the SW message handler (panel write channel).
// scheduler (armSchedule/disarmSchedule) is mocked; runScheduleDep is injected.

import { describe, it, expect, beforeEach, vi, type MockedFunction } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import {
  createScheduleOp,
  updateScheduleOp,
  deleteScheduleOp,
  toggleScheduleOp,
  runScheduleNowOp,
  setScheduleOpsRunDep,
} from "./schedule-ops";
import { getSchedule, listSchedules, putSchedule } from "./store";
import { armSchedule, disarmSchedule } from "./scheduler";
import type { ScheduleRecord } from "./types";
import { MIN_INTERVAL_MINUTES } from "./types";

vi.mock("./scheduler", () => ({
  armSchedule: vi.fn().mockResolvedValue(undefined),
  disarmSchedule: vi.fn().mockResolvedValue(undefined),
}));

const mockedArm = armSchedule as MockedFunction<typeof armSchedule>;
const mockedDisarm = disarmSchedule as MockedFunction<typeof disarmSchedule>;

function makeSched(overrides: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
  return {
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
    ...overrides,
  };
}

beforeEach(async () => {
  await _resetForTests();
  mockedArm.mockClear();
  mockedDisarm.mockClear();
  setScheduleOpsRunDep(async () => {});
});

describe("createScheduleOp", () => {
  it("persists a record and arms it", async () => {
    const res = await createScheduleOp({
      title: "Daily digest",
      prompt: "summarize",
      instanceId: "inst_1",
      spec: { intervalMinutes: 60, maxRuns: 5 },
    });
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; id: string }).id;
    const stored = await getSchedule(id);
    expect(stored?.title).toBe("Daily digest");
    expect(stored?.enabled).toBe(true);
    expect(stored?.status).toBe("active");
    expect(mockedArm).toHaveBeenCalledTimes(1);
  });

  it("rejects empty title", async () => {
    const res = await createScheduleOp({ title: "  ", prompt: "x", instanceId: "i" });
    expect(res.ok).toBe(false);
  });

  it("rejects interval below the minimum", async () => {
    const res = await createScheduleOp({
      title: "t",
      prompt: "p",
      instanceId: "i",
      spec: { intervalMinutes: MIN_INTERVAL_MINUTES - 1 },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a restricted startUrl", async () => {
    const res = await createScheduleOp({
      title: "t",
      prompt: "p",
      instanceId: "i",
      startUrl: "chrome://settings",
    });
    expect(res.ok).toBe(false);
  });
});

describe("updateScheduleOp", () => {
  it("patches prompt without re-arming when spec unchanged", async () => {
    await putSchedule(makeSched({ id: "sched_a" }));
    const res = await updateScheduleOp({ id: "sched_a", prompt: "new prompt" });
    expect(res.ok).toBe(true);
    expect((await getSchedule("sched_a"))?.prompt).toBe("new prompt");
    expect(mockedDisarm).not.toHaveBeenCalled();
    expect(mockedArm).not.toHaveBeenCalled();
  });

  it("re-arms (disarm + arm) when interval changes on an active schedule", async () => {
    await putSchedule(makeSched({ id: "sched_b" }));
    const res = await updateScheduleOp({ id: "sched_b", spec: { intervalMinutes: 30 } });
    expect(res.ok).toBe(true);
    expect(mockedDisarm).toHaveBeenCalledWith("sched_b");
    expect(mockedArm).toHaveBeenCalledTimes(1);
  });

  it("returns error for unknown id", async () => {
    const res = await updateScheduleOp({ id: "sched_missing", prompt: "x" });
    expect(res.ok).toBe(false);
  });
});

describe("deleteScheduleOp", () => {
  it("deletes the record and disarms", async () => {
    await putSchedule(makeSched({ id: "sched_c" }));
    const res = await deleteScheduleOp("sched_c");
    expect(res.ok).toBe(true);
    expect(await getSchedule("sched_c")).toBeNull();
    expect(mockedDisarm).toHaveBeenCalledWith("sched_c");
  });
});

describe("toggleScheduleOp (9.1 enabled wire)", () => {
  it("disabling patches enabled=false and disarms (no arm)", async () => {
    await putSchedule(makeSched({ id: "sched_d", enabled: true }));
    const res = await toggleScheduleOp("sched_d", false);
    expect(res.ok).toBe(true);
    expect((await getSchedule("sched_d"))?.enabled).toBe(false);
    expect(mockedDisarm).toHaveBeenCalledWith("sched_d");
    expect(mockedArm).not.toHaveBeenCalled();
  });

  it("enabling patches enabled=true and re-arms", async () => {
    await putSchedule(makeSched({ id: "sched_e", enabled: false }));
    const res = await toggleScheduleOp("sched_e", true);
    expect(res.ok).toBe(true);
    expect((await getSchedule("sched_e"))?.enabled).toBe(true);
    expect(mockedArm).toHaveBeenCalledTimes(1);
  });

  it("enabling a completed schedule does NOT re-arm (only active is armed)", async () => {
    await putSchedule(makeSched({ id: "sched_f", enabled: false, status: "completed" }));
    const res = await toggleScheduleOp("sched_f", true);
    expect(res.ok).toBe(true);
    expect((await getSchedule("sched_f"))?.enabled).toBe(true);
    expect(mockedArm).not.toHaveBeenCalled();
  });
});

describe("runScheduleNowOp", () => {
  it("invokes the injected runScheduleDep for the id", async () => {
    const dep = vi.fn().mockResolvedValue(undefined);
    setScheduleOpsRunDep(dep);
    await putSchedule(makeSched({ id: "sched_g" }));
    const res = await runScheduleNowOp("sched_g");
    expect(res.ok).toBe(true);
    expect(dep).toHaveBeenCalledWith("sched_g");
  });

  it("returns error for unknown id", async () => {
    const res = await runScheduleNowOp("sched_nope");
    expect(res.ok).toBe(false);
  });
});
