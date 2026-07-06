import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { HandoffParams, HandoffResult } from "@/types/local-bridge";

export interface HandoffToolDeps {
  run: (p: HandoffParams) => Promise<HandoffResult>;
  /** 桥：本机已检测 agent 列表（旧 daemon 的单项降级在 local-bridge 层做）。 */
  listAgents: () => Promise<{ id: string; label: string }[]>;
  /**
   * HITL 卡：用户选收件人 + 授权一步完成。返回选中的 agent id，null = 拒绝。
   * target 不由 LLM 传——被 untrusted 页面驱动的 LLM 无法诱导选收件人。
   */
  requestConsent: (p: {
    context: string;
    fileCount: number;
    agents: { id: string; label: string }[];
  }) => Promise<string | null>;
}

export function buildHandoffTool(deps: HandoffToolDeps): Tool {
  return {
    name: "handoff_to_agent",
    description:
      "Hand OFF an open-ended, interactive task to a local agent installed on the user's machine " +
      "(e.g. Claude Code, Codex). Unlike run_local_agent (which BLOCKS and returns output), this is " +
      "FIRE-AND-FORGET: it writes your context to context.md, stages any files you provide, and opens " +
      "an interactive session (terminal or app) where the local agent continues the work WITH THE " +
      "HUMAN PRESENT. You do NOT choose the recipient — the user picks it on the authorization card. " +
      "Use for open-ended / collaborative / long-running work that a blocking headless call can't " +
      "handle. You get back ONLY the handoff directory path — results are NOT returned to you. " +
      "Requires user authorization each call.",
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
      const agents = await deps.listAgents();
      if (agents.length === 0) {
        return {
          success: false,
          error:
            "handoff_to_agent: no supported local agents detected on this machine " +
            "(looked for the Claude app and the `claude` / `codex` CLIs).",
        };
      }
      const target = await deps.requestConsent({
        context: a.context,
        fileCount: files?.length ?? 0,
        agents,
      });
      if (target == null) {
        return { success: false, error: "User declined the hand-off." };
      }
      const result = await deps.run({ target, context: a.context, files });
      // fire-and-forget：无 untrusted 内容回传。dir 是 daemon 派生路径（可信），
      // 直接作 trusted observation 让 LLM 转述给用户去接着干。
      const label = agents.find((x) => x.id === target)?.label ?? target;
      const started =
        result.mode === "app"
          ? `The app was opened rooted at that folder; the user must send a message there to start the local agent.`
          : `An interactive terminal session was opened there and is already running.`;
      return {
        success: true,
        observation:
          `Handed off to ${label} (picked by the user). Handoff directory:\n` +
          `${result.dir}\n` +
          `${started}\n` +
          `This is fire-and-forget — the local agent continues independently with the user; ` +
          `results are NOT returned here.`,
      };
    },
  };
}
