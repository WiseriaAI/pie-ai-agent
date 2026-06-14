// src/lib/schedules/panel-actions.ts
//
// Task 9 — panel→SW write channel for schedule mutations.
//
// Architecture (per Task 9 spec): the side panel reads schedules directly from
// IDB (listSchedules / getRun), but it MUST NOT call scheduler/runSchedule
// directly. Mutations route through the SW so they execute with the SW's REAL
// deps-bound runSchedule (needed for chrome.alarms' immediate-dispatch branch)
// — the trap Task 7 hit. This module is the thin panel-side client; the SW
// handler (background/index.ts) calls the shared schedule-ops core.

import type { ScheduleSpec } from "./types";

export const SCHEDULE_ACTION_MESSAGE = "schedule-action" as const;

export type ScheduleAction =
  | { action: "create"; payload: ScheduleCreatePayload }
  | { action: "update"; payload: ScheduleUpdatePayload }
  | { action: "delete"; payload: { id: string } }
  | { action: "toggle"; payload: { id: string; enabled: boolean } }
  | { action: "run-now"; payload: { id: string } };

export interface ScheduleCreatePayload {
  title: string;
  prompt: string;
  instanceId: string;
  model?: string;
  spec?: ScheduleSpec;
  startUrl?: string;
  maxStepsPerRun?: number;
  maxRunMs?: number;
}

export interface ScheduleUpdatePayload {
  id: string;
  instanceId?: string;
  model?: string;
  title?: string;
  prompt?: string;
  spec?: Partial<ScheduleSpec>;
  startUrl?: string;
  maxStepsPerRun?: number;
  maxRunMs?: number;
}

export interface ScheduleActionMessage {
  type: typeof SCHEDULE_ACTION_MESSAGE;
  action: ScheduleAction["action"];
  payload: ScheduleAction["payload"];
}

export type ScheduleActionResponse =
  | { ok: true; id?: string }
  | { ok: false; error: string };

/**
 * Send a schedule mutation to the SW and await its result. Returns a structured
 * { ok, error? } so callers can surface failures in the form UI. Never throws on
 * a runtime messaging error — converts it to { ok:false }.
 */
async function send(
  action: ScheduleAction["action"],
  payload: ScheduleAction["payload"],
): Promise<ScheduleActionResponse> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: SCHEDULE_ACTION_MESSAGE,
      action,
      payload,
    })) as ScheduleActionResponse | undefined;
    if (!res) return { ok: false, error: "no response from background worker" };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function createSchedule(payload: ScheduleCreatePayload): Promise<ScheduleActionResponse> {
  return send("create", payload);
}
export function updateSchedule(payload: ScheduleUpdatePayload): Promise<ScheduleActionResponse> {
  return send("update", payload);
}
export function deleteSchedule(id: string): Promise<ScheduleActionResponse> {
  return send("delete", { id });
}
export function toggleSchedule(id: string, enabled: boolean): Promise<ScheduleActionResponse> {
  return send("toggle", { id, enabled });
}
export function runScheduleNow(id: string): Promise<ScheduleActionResponse> {
  return send("run-now", { id });
}
