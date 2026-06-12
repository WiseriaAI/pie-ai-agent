import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { migrateScheduleSessionOrigin } from "./migrate-schedule-session-origin";
import { createSession, setSessionMeta, listSessionIndex } from "./storage";
import { getIndex, setIndex } from "@/lib/idb/sessions-store";
import { putSchedule, appendRun } from "@/lib/schedules/store";
import { getConfig } from "@/lib/idb/config-store";
import type { ScheduleRecord } from "@/lib/schedules/types";

const SENTINEL = "schedule_session_origin_backfilled_v1";

function makeSched(id: string, runIds: string[]): ScheduleRecord {
  return {
    id,
    title: "t",
    prompt: "p",
    spec: { intervalMinutes: 60 },
    instanceId: "inst_1",
    enabled: true,
    status: "active",
    createdAt: 1,
    runCount: runIds.length,
    consecutiveFailures: 0,
    runIds,
  };
}

beforeEach(async () => {
  await _resetForTests();
});

describe("indexEntryFromMeta — origin propagation", () => {
  it("a schedule-origin session surfaces origin on its index entry; a normal one does not", async () => {
    const normal = await createSession({});
    const sched = await createSession({});
    await setSessionMeta({
      ...sched,
      origin: "schedule",
      messages: [{ role: "user", content: "x" }],
    });

    const index = await listSessionIndex();
    expect(index.find((e) => e.id === sched.id)!.origin).toBe("schedule");
    expect(index.find((e) => e.id === normal.id)!.origin).toBeUndefined();
  });
});

describe("migrateScheduleSessionOrigin — one-time backfill", () => {
  it("restores origin onto a pre-fix index entry that lacks it, then sets the sentinel", async () => {
    // A schedule session whose meta carries origin…
    const session = await createSession({});
    await setSessionMeta({
      ...session,
      origin: "schedule",
      scheduleId: "sched_1",
      recordId: "run_1",
      messages: [{ role: "user", content: "scheduled run" }],
    });
    // …reachable from a schedule run record.
    await putSchedule(makeSched("sched_1", []));
    await appendRun("sched_1", {
      recordId: "run_1",
      scheduleId: "sched_1",
      runIndex: 1,
      sessionId: session.id,
      startedAt: 1,
      status: "success",
    });

    // Simulate the PRE-FIX state: strip origin from the index entry.
    const stale = (await getIndex()).map((e) =>
      e.id === session.id ? { ...e, origin: undefined } : e,
    );
    await setIndex(stale);
    expect((await listSessionIndex()).find((e) => e.id === session.id)!.origin).toBeUndefined();

    await migrateScheduleSessionOrigin();

    expect((await listSessionIndex()).find((e) => e.id === session.id)!.origin).toBe("schedule");
    expect(await getConfig(SENTINEL)).toBe(true);
  });

  it("no schedules → no-op but still records the sentinel", async () => {
    await migrateScheduleSessionOrigin();
    expect(await getConfig(SENTINEL)).toBe(true);
  });

  it("is guarded: once the sentinel is set it does not reprocess", async () => {
    // Pre-set the sentinel; seed a stale schedule session that WOULD be fixed.
    const session = await createSession({});
    await setSessionMeta({ ...session, origin: "schedule", messages: [{ role: "user", content: "x" }] });
    await putSchedule(makeSched("sched_g", []));
    await appendRun("sched_g", {
      recordId: "run_g",
      scheduleId: "sched_g",
      runIndex: 1,
      sessionId: session.id,
      startedAt: 1,
      status: "success",
    });
    const stale = (await getIndex()).map((e) =>
      e.id === session.id ? { ...e, origin: undefined } : e,
    );
    await setIndex(stale);

    // First run sets the sentinel and fixes the entry.
    await migrateScheduleSessionOrigin();
    expect((await listSessionIndex()).find((e) => e.id === session.id)!.origin).toBe("schedule");

    // Re-stale the entry, then run again: guarded → entry stays stale.
    await setIndex((await getIndex()).map((e) => (e.id === session.id ? { ...e, origin: undefined } : e)));
    await migrateScheduleSessionOrigin();
    expect((await listSessionIndex()).find((e) => e.id === session.id)!.origin).toBeUndefined();
  });
});
