// Task 7 — Schedule autonomous CRUD meta tools.
//
// 4 tools registered into BUILT_IN_TOOLS:
//   create_schedule — persist a new recurring agent task (+ armSchedule)
//   update_schedule — patch an existing schedule (+ re-arm if spec changed)
//   delete_schedule — delete a schedule + disarmSchedule
//   list_schedules  — list schedule summaries
//
// Security / quota guards:
//   - title / prompt must be non-empty strings
//   - intervalMinutes (if set) must be >= MIN_INTERVAL_MINUTES (15)
//   - startUrl (if set) must not be a restricted URL (chrome://, Web Store, etc.)
//   - total schedules < MAX_SCHEDULES (20)
//   - instanceId defaults to the active instance when not provided
//
// Recursive creation prevention (7.4):
//   - headless runs (run.ts) pass excludeToolNames that removes
//     create_schedule and update_schedule from the loop's tool set, so a
//     scheduled agent cannot create or modify schedules on its own.

import type { ActionResult } from "../../dom-actions/types";
import type { Tool } from "../types";
import { listSchedules } from "../../schedules/store";
import {
  createScheduleOp,
  updateScheduleOp,
  deleteScheduleOp,
  setScheduleOpsRunDep,
} from "../../schedules/schedule-ops";
import {
  MIN_INTERVAL_MINUTES,
  type ScheduleSpec,
} from "../../schedules/types";
import { getConfig } from "../../idb/config-store";

// ── Helpers ──────────────────────────────────────────────────────────────────

function err(reason: string): ActionResult {
  return { success: false, error: reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const ACTIVE_KEY = "active_instance_id";

async function getActiveInstanceId(): Promise<string | null> {
  return (await getConfig<string>(ACTIVE_KEY)) ?? null;
}

// ── Injected runSchedule dispatcher (C1 fix) ─────────────────────────────────
//
// The create/update/delete store + arm/disarm sequences now live in the shared
// schedule-ops module (src/lib/schedules/schedule-ops.ts), reused by both these
// agent tools and the SW message handler (panel write channel). The injected
// deps-bound runSchedule (needed so an immediate first run dispatches through
// the real agent loop instead of being dropped) is held there. setScheduleRunDep
// is re-exported here for back-compat with background/index.ts's single boot-time
// injection call; it forwards to setScheduleOpsRunDep.
export function setScheduleRunDep(fn: (scheduleId: string) => Promise<void>): void {
  setScheduleOpsRunDep(fn);
}

// ── Tool: create_schedule ────────────────────────────────────────────────────

const createScheduleTool: Tool = {
  name: "create_schedule",
  description:
    "Create a new scheduled agent task. The agent will run the given prompt automatically on the specified interval. Use when the user asks to automate a recurring task (e.g. 'every day summarize my emails').",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["title", "prompt"],
    properties: {
      title: {
        type: "string",
        description: "Short human-readable label for this schedule.",
      },
      prompt: {
        type: "string",
        description: "The task prompt the agent will execute on each run.",
      },
      spec: {
        type: "object",
        additionalProperties: false,
        description: "Timing specification.",
        properties: {
          startAt: {
            type: "number",
            description: "First run timestamp in ms (epoch). Defaults to run immediately.",
          },
          intervalMinutes: {
            type: "number",
            description: `Repeat interval in minutes. Must be >= ${MIN_INTERVAL_MINUTES}. Omit for a one-shot run.`,
          },
          maxRuns: {
            type: "number",
            description: "Total run cap. Omit for unlimited. Only meaningful with intervalMinutes.",
          },
        },
      },
      startUrl: {
        type: "string",
        description:
          "Optional URL to open in a background tab before each run. Restricted pages (chrome://, Web Store) are rejected.",
      },
      instanceId: {
        type: "string",
        description:
          "Instance to use for this schedule. Defaults to the current active instance.",
      },
      maxStepsPerRun: {
        type: "number",
        description: "Optional hard step cap per run. Absent = no ceiling (LLM-controlled).",
      },
      maxRunMs: {
        type: "number",
        description: "Optional wall-clock budget in milliseconds per run.",
      },
    },
  },
  handler: async (args: unknown): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

    if (!isNonEmptyString(a.title)) return err("title is required and must be a non-empty string");
    if (!isNonEmptyString(a.prompt)) return err("prompt is required and must be a non-empty string");

    const spec: ScheduleSpec = {};
    if (a.spec && typeof a.spec === "object") {
      const s = a.spec as Record<string, unknown>;
      if (s.startAt !== undefined) spec.startAt = s.startAt as number;
      if (s.intervalMinutes !== undefined) spec.intervalMinutes = s.intervalMinutes as number;
      if (s.maxRuns !== undefined) spec.maxRuns = s.maxRuns as number;
    }

    // Resolve instanceId: explicit arg or fall back to active instance
    let instanceId: string;
    if (isNonEmptyString(a.instanceId)) {
      instanceId = a.instanceId;
    } else {
      const active = await getActiveInstanceId();
      if (!active) return err("no active instance configured — provide instanceId explicitly");
      instanceId = active;
    }

    // Delegate to the shared ops core (validation, quota gate, store put + arm).
    const res = await createScheduleOp({
      title: a.title,
      prompt: a.prompt,
      instanceId,
      spec,
      ...(isNonEmptyString(a.startUrl) ? { startUrl: a.startUrl } : {}),
      ...(a.maxStepsPerRun !== undefined ? { maxStepsPerRun: a.maxStepsPerRun as number } : {}),
      ...(a.maxRunMs !== undefined ? { maxRunMs: a.maxRunMs as number } : {}),
    });
    if (!res.ok) return err(res.error);

    return {
      success: true,
      observation: `schedule created: id=${res.id} title="${a.title.trim()}" instanceId=${instanceId}. It will run automatically as scheduled.`,
    };
  },
};

// ── Tool: update_schedule ────────────────────────────────────────────────────

const updateScheduleTool: Tool = {
  name: "update_schedule",
  description:
    "Modify an existing schedule's title, prompt, spec, or other fields. When the spec (startAt or intervalMinutes) changes, the alarm is re-armed automatically.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", description: "Id of the schedule to update (sched_*)." },
      title: { type: "string", description: "New title." },
      prompt: { type: "string", description: "New prompt." },
      spec: {
        type: "object",
        additionalProperties: false,
        properties: {
          startAt: { type: "number" },
          intervalMinutes: { type: "number" },
          maxRuns: { type: "number" },
        },
      },
      startUrl: { type: "string", description: "New startUrl (or empty string to clear)." },
      maxStepsPerRun: { type: "number" },
      maxRunMs: { type: "number" },
    },
  },
  handler: async (args: unknown): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    if (!isNonEmptyString(a.id)) return err("id is required");
    const id = a.id;

    // Build a partial spec only from the keys explicitly present, so the ops
    // layer can tell "set to undefined" apart from "not touched".
    let specInput: Partial<ScheduleSpec> | undefined;
    if ("spec" in a && a.spec && typeof a.spec === "object") {
      const s = a.spec as Record<string, unknown>;
      specInput = {};
      if ("startAt" in s) specInput.startAt = s.startAt as number | undefined;
      if ("intervalMinutes" in s) specInput.intervalMinutes = s.intervalMinutes as number | undefined;
      if ("maxRuns" in s) specInput.maxRuns = s.maxRuns as number | undefined;
    }

    const res = await updateScheduleOp({
      id,
      ...("title" in a ? { title: a.title as string } : {}),
      ...("prompt" in a ? { prompt: a.prompt as string } : {}),
      ...(specInput ? { spec: specInput } : {}),
      ...("startUrl" in a ? { startUrl: (a.startUrl as string | undefined) ?? "" } : {}),
      ...("maxStepsPerRun" in a ? { maxStepsPerRun: a.maxStepsPerRun as number } : {}),
      ...("maxRunMs" in a ? { maxRunMs: a.maxRunMs as number } : {}),
    });
    if (!res.ok) return err(res.error);

    return { success: true, observation: `schedule updated: id=${id}` };
  },
};

// ── Tool: delete_schedule ────────────────────────────────────────────────────

const deleteScheduleTool: Tool = {
  name: "delete_schedule",
  description: "Permanently delete a schedule and cancel its next run. All run history is also deleted.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", description: "Id of the schedule to delete (sched_*)." },
    },
  },
  handler: async (args: unknown): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as { id?: unknown };
    if (!isNonEmptyString(a.id)) return err("id is required");
    const id = a.id;

    const res = await deleteScheduleOp(id);
    if (!res.ok) return err(res.error);

    return { success: true, observation: `schedule deleted: ${id}` };
  },
};

// ── Tool: list_schedules ─────────────────────────────────────────────────────

const listSchedulesTool: Tool = {
  name: "list_schedules",
  description:
    "List all schedules with their id, title, spec, enabled, status, nextRunAt, and runCount. Use before create_schedule to avoid duplicates.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  handler: async (): Promise<ActionResult> => {
    const all = await listSchedules();
    const summary = all.map((s) => ({
      id: s.id,
      title: s.title,
      spec: s.spec,
      enabled: s.enabled,
      status: s.status,
      nextRunAt: s.nextRunAt,
      runCount: s.runCount,
    }));
    return { success: true, observation: JSON.stringify(summary) };
  },
};

// ── Public exports ────────────────────────────────────────────────────────────

export const SCHEDULE_META_TOOLS: Tool[] = [
  createScheduleTool,
  updateScheduleTool,
  deleteScheduleTool,
  listSchedulesTool,
];

export const SCHEDULE_META_TOOL_NAMES = [
  "create_schedule",
  "update_schedule",
  "delete_schedule",
  "list_schedules",
] as const;

export type ScheduleMetaToolName = (typeof SCHEDULE_META_TOOL_NAMES)[number];

export function isScheduleMetaToolName(name: string): name is ScheduleMetaToolName {
  return (SCHEDULE_META_TOOL_NAMES as readonly string[]).includes(name);
}
