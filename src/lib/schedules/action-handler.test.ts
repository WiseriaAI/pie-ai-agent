// src/lib/schedules/action-handler.test.ts
//
// Task 9 — SW-side handler that backs the panel write channel. Routes a
// validated { action, payload } to the shared schedule-ops core. scheduler is
// mocked (no chrome.alarms); the injected runScheduleDep is stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { handleScheduleAction } from "./action-handler";
import { setScheduleOpsRunDep } from "./schedule-ops";
import { getSchedule, putSchedule } from "./store";
import type { ScheduleRecord } from "./types";

vi.mock("./scheduler", () => ({
  armSchedule: vi.fn().mockResolvedValue(undefined),
  disarmSchedule: vi.fn().mockResolvedValue(undefined),
}));

function makeSched(overrides: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
  return {
    title: "T",
    prompt: "p",
    spec: { intervalMinutes: 60 },
    instanceId: "inst_1",
    enabled: true,
    status: "active",
    createdAt: 1,
    runCount: 0,
    consecutiveFailures: 0,
    runIds: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await _resetForTests();
  setScheduleOpsRunDep(async () => {});
});

describe("handleScheduleAction", () => {
  it("create → ok + id, record persisted", async () => {
    const res = await handleScheduleAction({
      action: "create",
      payload: { title: "X", prompt: "do", instanceId: "inst_1", spec: { intervalMinutes: 30 } },
    });
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; id: string }).id;
    expect((await getSchedule(id))?.title).toBe("X");
  });

  it("toggle off → enabled=false persisted", async () => {
    await putSchedule(makeSched({ id: "sched_t" }));
    const res = await handleScheduleAction({ action: "toggle", payload: { id: "sched_t", enabled: false } });
    expect(res.ok).toBe(true);
    expect((await getSchedule("sched_t"))?.enabled).toBe(false);
  });

  it("delete → record gone", async () => {
    await putSchedule(makeSched({ id: "sched_d" }));
    const res = await handleScheduleAction({ action: "delete", payload: { id: "sched_d" } });
    expect(res.ok).toBe(true);
    expect(await getSchedule("sched_d")).toBeNull();
  });

  it("run-now → invokes the injected dispatcher", async () => {
    const dep = vi.fn().mockResolvedValue(undefined);
    setScheduleOpsRunDep(dep);
    await putSchedule(makeSched({ id: "sched_r" }));
    const res = await handleScheduleAction({ action: "run-now", payload: { id: "sched_r" } });
    expect(res.ok).toBe(true);
    expect(dep).toHaveBeenCalledWith("sched_r");
  });

  it("unknown action → ok:false", async () => {
    const res = await handleScheduleAction({ action: "bogus" as never, payload: {} as never });
    expect(res.ok).toBe(false);
  });

  it("malformed payload → ok:false (does not throw)", async () => {
    const res = await handleScheduleAction({ action: "delete", payload: { id: "" } as never });
    expect(res.ok).toBe(false);
  });
});
