import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import {
  resolveLoadTools,
  buildActivationNotice,
  LOADABLE_GROUPS,
  GROUP_META,
} from "../disclosure";
import type { DisclosureGroup } from "../tool-names";

export interface LoadToolsDeps {
  /** Live reference to the loop's activeToolGroups set (mutated in place). */
  getActiveGroups: () => Set<string>;
  /** Headless (scheduled) runs cannot load the schedule group. */
  headless: boolean;
}

export function buildLoadToolsTool(deps: LoadToolsDeps): Tool {
  const loadableList = LOADABLE_GROUPS.filter(
    (g) => !(deps.headless && g === "schedule"),
  );
  const catalog = loadableList
    .map((g) => `${g}: ${GROUP_META[g].catalogLine}`)
    .join("; ");
  return {
    name: "load_tools",
    description:
      "Load an on-demand tool group so its tools become callable next turn. " +
      "Use when the task needs a capability not in your current tool set. " +
      `Loadable groups — ${catalog}.`,
    parameters: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: { type: "string", enum: loadableList },
          description: 'Group ids to load (e.g. ["pdf"], ["scratchpad"]).',
        },
      },
      required: ["groups"],
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { groups?: unknown };
      const groups = Array.isArray(a.groups) ? a.groups.map(String) : [];
      if (groups.length === 0) {
        return {
          success: false,
          observation:
            "load_tools: `groups` is required (non-empty array). Valid groups: " +
            loadableList.join(", ") + ".",
          error: "missingGroups",
        };
      }
      const active = deps.getActiveGroups();
      const r = resolveLoadTools(groups, active, { headless: deps.headless });
      const lines: string[] = [];
      if (r.loaded.length) {
        const notice = buildActivationNotice(r.loaded as DisclosureGroup[]);
        if (notice) lines.push(notice);
      }
      if (r.alreadyActive.length) {
        lines.push(`Already active: ${r.alreadyActive.join(", ")}.`);
      }
      if (r.unknown.length) {
        lines.push(
          `Unknown / not loadable: ${r.unknown.join(", ")}. Valid groups: ` +
            loadableList.join(", ") + ".",
        );
      }
      return {
        success: r.loaded.length > 0 || r.alreadyActive.length > 0,
        observation: lines.join("\n\n"),
      };
    },
  };
}
