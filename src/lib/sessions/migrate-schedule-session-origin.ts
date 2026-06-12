// src/lib/sessions/migrate-schedule-session-origin.ts
//
// One-time backfill. Schedule-originated sessions created before
// SessionIndexEntry.origin existed have index entries WITHOUT the discriminator,
// so the SessionDrawer (which now hides sessions by `entry.origin === "schedule"`)
// would still list those older runs. Re-write each schedule session's meta once
// so `indexEntryFromMeta` re-derives the index entry WITH origin.
//
// Targeted + cheap: it only touches sessions referenced by a schedule run record
// (bounded by the run history), not every session. Guarded by a config sentinel
// so it runs exactly once. Best-effort — a failure leaves the sentinel unset so a
// later startup retries, and never blocks the pipeline.

import { getConfig, setConfig } from "@/lib/idb/config-store";
import { listSchedules, getRun } from "@/lib/schedules/store";
import { getSessionMeta, setSessionMeta } from "@/lib/sessions/storage";

const SENTINEL = "schedule_session_origin_backfilled_v1";

export async function migrateScheduleSessionOrigin(): Promise<void> {
  try {
    if (await getConfig<boolean>(SENTINEL)) return;

    const schedules = await listSchedules();
    const sessionIds = new Set<string>();
    for (const s of schedules) {
      for (const runId of s.runIds) {
        const run = await getRun(runId);
        if (run?.sessionId) sessionIds.add(run.sessionId);
      }
    }

    for (const sid of sessionIds) {
      const meta = await getSessionMeta(sid);
      // Re-persist only confirmed schedule sessions; setSessionMeta re-derives
      // the index entry (now carrying origin). Content is unchanged → idempotent.
      if (meta?.origin === "schedule") {
        await setSessionMeta(meta);
      }
    }

    await setConfig(SENTINEL, true);
  } catch {
    // Best-effort: never block startup. Sentinel stays unset → retried later.
  }
}
