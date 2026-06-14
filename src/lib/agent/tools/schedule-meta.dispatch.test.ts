// src/lib/agent/tools/schedule-meta.dispatch.test.ts
//
// I2 — real-dispatch coverage for the C1 fix.
//
// The sibling schedule-meta.test.ts vi.mock()s the WHOLE scheduler module, so it
// can't see whether create_schedule passes a no-op vs the real dispatcher into
// armSchedule — which is exactly how the C1 bug (immediate first run silently
// dropped) slipped through. This file leaves scheduler UNMOCKED, stubs
// chrome.alarms (mirroring scheduler.test.ts), injects a spy dispatcher via
// setScheduleRunDep, and asserts the real armSchedule path:
//   - create with NO startAt  → dispatches the first run NOW (spy called),
//     no alarm created.
//   - create with FUTURE startAt → creates a chrome.alarm, does NOT dispatch.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { SCHEDULE_META_TOOLS, setScheduleRunDep } from "./schedule-meta";
import type { ToolHandlerContext } from "../types";

// ── chrome.alarms stub (mirrors scheduler.test.ts) ───────────────────────────

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

// create_schedule binds the current chat session's instance from ctx (#181);
// supply it directly so the C1 dispatch path is exercised without depending on
// resolveSelection / a seeded instance record.
const TEST_INSTANCE_ID = "test-instance-001";
const ctx = { currentInstanceId: TEST_INSTANCE_ID } as ToolHandlerContext;
const create = SCHEDULE_META_TOOLS.find((t) => t.name === "create_schedule")!;

let stub: ReturnType<typeof installChromeStub>;
let runSpy: ReturnType<typeof vi.fn<(scheduleId: string) => Promise<void>>>;

beforeEach(async () => {
  await _resetForTests();
  stub = installChromeStub();
  runSpy = vi.fn<(scheduleId: string) => Promise<void>>(async () => {});
  setScheduleRunDep(runSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset the injected dispatcher back to the inert default so other test files
  // sharing this worker process aren't affected by our spy.
  setScheduleRunDep(async () => {});
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("create_schedule real-dispatch path (C1 regression)", () => {
  it("no startAt → dispatches the FIRST run immediately via injected runSchedule (no alarm)", async () => {
    const r = await create.handler(
      { title: "Immediate", prompt: "run now" },
      ctx,
    );
    expect(r.success).toBe(true);

    // C1: the immediate first run must actually fire through the injected
    // dispatcher — NOT be swallowed by a no-op.
    expect(runSpy).toHaveBeenCalledTimes(1);
    // armSchedule's immediate branch creates no alarm.
    expect(stub.create).not.toHaveBeenCalled();

    // The dispatched id matches the created schedule.
    const { listSchedules } = await import("@/lib/schedules/store");
    const all = await listSchedules();
    expect(all).toHaveLength(1);
    expect(runSpy).toHaveBeenCalledWith(all[0]!.id);
  });

  it("future startAt → creates a chrome.alarm and does NOT dispatch immediately", async () => {
    const future = Date.now() + 60 * 60 * 1000;
    const r = await create.handler(
      { title: "Later", prompt: "run later", spec: { startAt: future } },
      ctx,
    );
    expect(r.success).toBe(true);

    const { listSchedules } = await import("@/lib/schedules/store");
    const all = await listSchedules();
    expect(all).toHaveLength(1);

    expect(stub.create).toHaveBeenCalledWith(`schedule:${all[0]!.id}`, { when: future });
    expect(runSpy).not.toHaveBeenCalled();
  });
});
