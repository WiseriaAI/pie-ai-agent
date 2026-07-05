import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { HandoffParams, HandoffResult } from "@/types/local-bridge";

export interface HandoffToolDeps {
  run: (p: HandoffParams) => Promise<HandoffResult>;
  /** HITL 授权卡：展示 context + target + 文件数原文，返回是否放行。 */
  requestConsent: (p: { context: string; target: string; fileCount: number }) => Promise<boolean>;
}

export function buildHandoffTool(deps: HandoffToolDeps): Tool {
  return {
    name: "handoff_to_agent",
    description:
      "Hand OFF an open-ended, interactive task to the user's local Claude Code in a real terminal " +
      "session. Unlike run_local_agent (which BLOCKS and returns output), this is FIRE-AND-FORGET: it " +
      "writes your context to context.md, stages any files you provide, and opens an interactive " +
      "terminal where the user's local agent continues the work WITH THE HUMAN PRESENT. Use for " +
      "open-ended / collaborative / long-running work that a blocking headless call can't handle. You " +
      "get back ONLY the handoff directory path — results are NOT returned to you. Requires user " +
      "authorization each call.",
    parameters: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "A markdown brief for the local agent: what was done so far and what to continue. Written to context.md.",
        },
        files: {
          type: "array",
          description: "Optional files to stage into the handoff directory alongside context.md.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "File name (basename only; directories are stripped)." },
              content: { type: "string", description: "File content." },
            },
            required: ["name", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["context"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { context?: unknown; files?: unknown };
      if (typeof a.context !== "string" || a.context.trim() === "") {
        return { success: false, error: "handoff_to_agent: `context` is required (non-empty string)." };
      }
      const files = Array.isArray(a.files)
        ? (a.files as { name: string; content: string }[])
        : undefined;
      const granted = await deps.requestConsent({
        context: a.context,
        target: "claude",
        fileCount: files?.length ?? 0,
      });
      if (!granted) {
        return { success: false, error: "User declined the hand-off." };
      }
      const result = await deps.run({ target: "claude", context: a.context, files });
      // fire-and-forget：无 untrusted 内容回传。dir 是 daemon 派生路径（可信），
      // 直接作 trusted observation 让 LLM 转述给用户去那个终端接着干。
      return {
        success: true,
        observation:
          `Handed off to the user's local Claude Code. An interactive terminal session was opened at:\n` +
          `${result.dir}\n` +
          `This is fire-and-forget — the local agent continues independently with the user; ` +
          `results are NOT returned here.`,
      };
    },
  };
}
