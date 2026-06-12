// src/lib/schedules/action-handler.ts
//
// Task 9 — SW-side handler for the panel write channel. Receives a validated
// { action, payload } (the panel sends it via chrome.runtime.sendMessage), maps
// it onto the shared schedule-ops core, and returns a structured response the
// panel awaits. Kept separate from background/index.ts so it's unit-testable
// without the SW's heavy chrome side effects.
//
// The runScheduleDep used by create/run-now/toggle-arm is injected ONCE at SW
// boot (setScheduleOpsRunDep, called from background/index.ts) — this handler
// just routes; it never re-injects.

import {
  createScheduleOp,
  updateScheduleOp,
  deleteScheduleOp,
  toggleScheduleOp,
  runScheduleNowOp,
  type OpResult,
} from "./schedule-ops";
import type { ScheduleAction } from "./panel-actions";

export type { ScheduleActionResponse } from "./panel-actions";

/**
 * Route a schedule action to the shared ops core. Always resolves (never
 * rejects); a thrown op error becomes { ok:false }.
 */
export async function handleScheduleAction(msg: {
  action: ScheduleAction["action"];
  payload: ScheduleAction["payload"];
}): Promise<OpResult> {
  try {
    switch (msg.action) {
      case "create": {
        const p = msg.payload as Extract<ScheduleAction, { action: "create" }>["payload"];
        return await createScheduleOp(p);
      }
      case "update": {
        const p = msg.payload as Extract<ScheduleAction, { action: "update" }>["payload"];
        return await updateScheduleOp(p);
      }
      case "delete": {
        const p = msg.payload as Extract<ScheduleAction, { action: "delete" }>["payload"];
        return await deleteScheduleOp(p?.id);
      }
      case "toggle": {
        const p = msg.payload as Extract<ScheduleAction, { action: "toggle" }>["payload"];
        return await toggleScheduleOp(p?.id, p?.enabled);
      }
      case "run-now": {
        const p = msg.payload as Extract<ScheduleAction, { action: "run-now" }>["payload"];
        return await runScheduleNowOp(p?.id);
      }
      default:
        return { ok: false, error: `unknown schedule action: ${String(msg.action)}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
