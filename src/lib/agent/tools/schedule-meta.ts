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
import {
  getSchedule,
  listSchedules,
  putSchedule,
  deleteSchedule,
  patchSchedule,
} from "../../schedules/store";
import { armSchedule, disarmSchedule } from "../../schedules/scheduler";
import { isRestrictedScheduleUrl } from "../../schedules/url-guard";
import {
  newScheduleId,
  MIN_INTERVAL_MINUTES,
  MAX_SCHEDULES,
  type ScheduleRecord,
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

/**
 * Validate a ScheduleSpec patch for the interval constraint.
 * Returns an error string if invalid, or null if valid.
 */
function validateSpec(spec: Partial<ScheduleSpec>): string | null {
  if (
    spec.intervalMinutes !== undefined &&
    spec.intervalMinutes < MIN_INTERVAL_MINUTES
  ) {
    return `intervalMinutes must be >= ${MIN_INTERVAL_MINUTES} (got ${spec.intervalMinutes})`;
  }
  return null;
}

// ── Injected runSchedule dispatcher (C1 fix) ─────────────────────────────────
//
// armSchedule needs SchedulerDeps.runSchedule: for a schedule with NO startAt
// (default = run immediately), armSchedule takes the immediate-fire branch and
// calls `dispatchRun(deps)` → deps.runSchedule(id) right away (no alarm is
// created). If we passed a no-op here, that FIRST run would be silently dropped
// and the schedule would sit `active` with a past nextRunAt and no armed alarm
// until the next SW restart's reconcile picked it up (spec §156 violation —
// immediate schedules must dispatch their first run on create).
//
// The tool layer is a static module and can't reach the SW's deps-bound
// runSchedule (background/index.ts `runScheduleWithDeps`, with RunDeps +
// keep-alive baked in). So the SW injects it at boot via `setScheduleRunDep`.
// Until injected (only true in non-SW contexts / before boot), we fall back to
// a no-op + warn so a stray call can never throw.
//
// (armSchedule / disarmSchedule are imported directly from scheduler.ts so
// vitest can `vi.mock("../../schedules/scheduler", …)`; the real-dispatch test
// instead leaves them unmocked and stubs chrome.alarms + setScheduleRunDep.)

type RunScheduleDispatcher = (scheduleId: string) => Promise<void>;

let runScheduleDep: RunScheduleDispatcher = async (id) => {
  console.warn(
    `[schedule-meta] runScheduleDep not injected — immediate run for ${id} dropped. ` +
      `setScheduleRunDep() must be called at SW boot.`,
  );
};

/**
 * Inject the SW's deps-bound runSchedule so create/update_schedule can dispatch
 * an immediate first run through the REAL agent loop (not a no-op). Called once
 * from background/index.ts after `schedulerDeps` is defined.
 */
export function setScheduleRunDep(fn: RunScheduleDispatcher): void {
  runScheduleDep = fn;
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

    const specErr = validateSpec(spec);
    if (specErr) return err(specErr);

    if (isNonEmptyString(a.startUrl) && isRestrictedScheduleUrl(a.startUrl)) {
      return err(
        `startUrl "${a.startUrl}" is a restricted page that cannot be used as a schedule startUrl (chrome://, about:, chrome-extension://, and the Chrome Web Store are not injectable).`,
      );
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

    // Quota gate
    const existing = await listSchedules();
    if (existing.length >= MAX_SCHEDULES) {
      return err(
        `schedule quota exceeded (max ${MAX_SCHEDULES}). Delete unused schedules via delete_schedule.`,
      );
    }

    const id = newScheduleId();
    const rec: ScheduleRecord = {
      id,
      title: a.title.trim(),
      prompt: a.prompt.trim(),
      spec,
      ...(isNonEmptyString(a.startUrl) ? { startUrl: a.startUrl } : {}),
      instanceId,
      enabled: true,
      status: "active",
      ...(a.maxStepsPerRun !== undefined ? { maxStepsPerRun: a.maxStepsPerRun as number } : {}),
      ...(a.maxRunMs !== undefined ? { maxRunMs: a.maxRunMs as number } : {}),
      runCount: 0,
      consecutiveFailures: 0,
      runIds: [],
      createdAt: Date.now(),
    };

    await putSchedule(rec);
    // Arm the schedule. For a future startAt this creates a chrome.alarm; for an
    // immediate schedule (no startAt) armSchedule dispatches the first run NOW
    // via runScheduleDep (the SW-injected, deps-bound runSchedule). Passing the
    // injected dep (not a no-op) is what keeps that first run from being dropped.
    await armSchedule(rec, { runSchedule: runScheduleDep });

    return {
      success: true,
      observation: `schedule created: id=${id} title="${rec.title}" instanceId=${instanceId}. It will run automatically as scheduled.`,
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

    const existing = await getSchedule(id);
    if (!existing) return err(`schedule not found: ${id}`);

    const patch: Partial<Omit<ScheduleRecord, "id">> = {};
    if ("title" in a) {
      if (!isNonEmptyString(a.title)) return err("title must be a non-empty string");
      patch.title = a.title.trim();
    }
    if ("prompt" in a) {
      if (!isNonEmptyString(a.prompt)) return err("prompt must be a non-empty string");
      patch.prompt = a.prompt.trim();
    }

    let specChanged = false;
    if ("spec" in a && a.spec && typeof a.spec === "object") {
      const s = a.spec as Record<string, unknown>;
      const newSpec: ScheduleSpec = { ...existing.spec };
      if ("startAt" in s) { newSpec.startAt = s.startAt as number | undefined; specChanged = true; }
      if ("intervalMinutes" in s) { newSpec.intervalMinutes = s.intervalMinutes as number | undefined; specChanged = true; }
      if ("maxRuns" in s) { newSpec.maxRuns = s.maxRuns as number | undefined; }

      const specErr = validateSpec(newSpec);
      if (specErr) return err(specErr);
      patch.spec = newSpec;
    }

    if ("startUrl" in a) {
      if (isNonEmptyString(a.startUrl) && isRestrictedScheduleUrl(a.startUrl)) {
        return err(`startUrl "${a.startUrl}" is restricted and cannot be used.`);
      }
      patch.startUrl = a.startUrl as string | undefined;
    }
    if ("maxStepsPerRun" in a) patch.maxStepsPerRun = a.maxStepsPerRun as number;
    if ("maxRunMs" in a) patch.maxRunMs = a.maxRunMs as number;

    await patchSchedule(id, patch);

    // Re-arm when spec timing changed (startAt or intervalMinutes). Uses the
    // injected runScheduleDep so an immediate re-arm dispatches through the real
    // agent loop (same C1 reasoning as create_schedule).
    if (specChanged) {
      await disarmSchedule(id);
      // Re-read post-patch to get the merged record
      const updated = await getSchedule(id);
      if (updated && updated.status === "active") {
        await armSchedule(updated, { runSchedule: runScheduleDep });
      }
    }

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

    const existing = await getSchedule(id);
    if (!existing) return err(`schedule not found: ${id}`);

    await deleteSchedule(id);
    await disarmSchedule(id);

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
