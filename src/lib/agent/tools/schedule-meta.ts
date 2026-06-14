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
//   - intervalMinutes (if set) must be >= MIN_INTERVAL_MINUTES
//   - startUrl (if set) must not be a restricted URL (chrome://, Web Store, etc.)
//   - total schedules < MAX_SCHEDULES (20)
//   - instanceId/model default to the current chat session, else resolveSelection
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
import { resolveSelection } from "../../model-selection-resolver";
import type { ToolHandlerContext } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function err(reason: string): ActionResult {
  return { success: false, error: reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Block B — coerce a tool-supplied `startAt` to epoch ms.
 *
 * The tool interface accepts a local-time ISO string (e.g. "2026-06-13T09:00",
 * no zone = device local) so the LLM can compute it from the `<current_time>`
 * block. Storage (`ScheduleSpec.startAt`) stays a plain epoch-ms number — this
 * is the single conversion point. A bare number is also accepted (back-compat:
 * `new Date(ms)` round-trips epoch ms). Returns `{ ok:false }` on an unparseable
 * value so the handler can surface a clear error instead of persisting NaN.
 */
function coerceStartAt(
  v: unknown,
): { ok: true; ms: number } | { ok: false; error: string } {
  const ms = new Date(v as string | number).getTime();
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      error: `invalid startAt: ${JSON.stringify(v)} — expected a local-time ISO string like "2026-06-13T09:00"`,
    };
  }
  return { ok: true, ms };
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
            type: "string",
            description:
              'First run time as a local-time ISO string (e.g. "2026-06-13T09:00"; no time zone = the device\'s local zone). Compute it from the `<current_time>` block at the start of the conversation. Omit to start a recurring task from the next interval, or a one-shot immediately.',
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
          "Instance to use for this schedule. Defaults to the model you're currently chatting with, else your configured default.",
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
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

    if (!isNonEmptyString(a.title)) return err("title is required and must be a non-empty string");
    if (!isNonEmptyString(a.prompt)) return err("prompt is required and must be a non-empty string");

    const spec: ScheduleSpec = {};
    if (a.spec && typeof a.spec === "object") {
      const s = a.spec as Record<string, unknown>;
      if (s.startAt !== undefined) {
        const r = coerceStartAt(s.startAt);
        if (!r.ok) return err(r.error);
        spec.startAt = r.ms;
      }
      if (s.intervalMinutes !== undefined) spec.intervalMinutes = s.intervalMinutes as number;
      if (s.maxRuns !== undefined) spec.maxRuns = s.maxRuns as number;
    }

    // 解析 (instanceId, model)：显式 arg → 当前会话 ctx → resolveSelection 兜底 → 错误。
    // model 仅在来源是会话/兜底（已解析出具体 (instance, model)）时绑定；显式
    // instanceId 无配对 model 时留空，运行时回退 firstModelForProvider。
    let instanceId: string;
    let model: string | undefined;
    if (isNonEmptyString(a.instanceId)) {
      instanceId = a.instanceId;
    } else if (isNonEmptyString(ctx.currentInstanceId)) {
      instanceId = ctx.currentInstanceId;
      model = isNonEmptyString(ctx.currentModel) ? ctx.currentModel : undefined;
    } else {
      const sel = await resolveSelection({});
      if (!sel) return err("no AI provider configured — add one in Settings, or pass an explicit instanceId");
      instanceId = sel.instanceId;
      model = sel.model;
    }

    const res = await createScheduleOp({
      title: a.title,
      prompt: a.prompt,
      instanceId,
      ...(model ? { model } : {}),
      spec,
      ...(isNonEmptyString(a.startUrl) ? { startUrl: a.startUrl } : {}),
      ...(a.maxStepsPerRun !== undefined ? { maxStepsPerRun: a.maxStepsPerRun as number } : {}),
      ...(a.maxRunMs !== undefined ? { maxRunMs: a.maxRunMs as number } : {}),
    });
    if (!res.ok) return err(res.error);

    return {
      success: true,
      observation: `schedule created: id=${res.id} title="${a.title.trim()}" instanceId=${instanceId}${model ? ` model=${model}` : ""}. It will run automatically as scheduled.`,
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
          startAt: {
            type: "string",
            description:
              'New first-run time as a local-time ISO string (e.g. "2026-06-13T09:00"; no time zone = device local). Compute it from the `<current_time>` block.',
          },
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
      if ("startAt" in s) {
        if (s.startAt === undefined) {
          specInput.startAt = undefined; // explicit clear
        } else {
          const r = coerceStartAt(s.startAt);
          if (!r.ok) return err(r.error);
          specInput.startAt = r.ms;
        }
      }
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
