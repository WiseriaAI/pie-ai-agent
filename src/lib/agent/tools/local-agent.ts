import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { RunLocalAgentResult } from "@/types/local-bridge";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";

export interface RunLocalAgentToolDeps {
  run: (p: { target: "claude"; prompt: string; cwd?: string }) => Promise<RunLocalAgentResult>;
  /** HITL 授权卡：展示 prompt + cwd 原文，返回是否放行。 */
  requestConsent: (p: { prompt: string; cwd: string }) => Promise<boolean>;
}

export function buildRunLocalAgentTool(deps: RunLocalAgentToolDeps): Tool {
  return {
    name: "run_local_agent",
    description:
      "DELEGATE a bounded, non-interactive sub-task to the user's local Claude Code agent " +
      "(claude -p, headless) and get its final output back — the conversation continues with the " +
      "result. Use for work that needs a full local coding/analysis agent with filesystem + shell " +
      "— e.g. run an analysis over exported files, generate code, summarize a repo. The call " +
      "BLOCKS until the local agent finishes. Decision rule vs handoff_to_agent: use " +
      "run_local_agent when THIS conversation still needs the output afterwards AND the task can " +
      "run unattended in one shot; use handoff_to_agent when the human will continue the work " +
      "locally (open-ended / interactive / long-running — results not needed back here). Heavy " +
      "writes inside a real project directory also favor handoff_to_agent (a human approves each " +
      "step there; this tool runs headless). Requires user authorization each call.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task for the local agent." },
        cwd: {
          type: "string",
          description:
            "Optional working directory for the local agent. Defaults to a fresh temp workspace. " +
            "Only pass a real project path when the task must run there — the user sees this path on the authorization card.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { prompt?: unknown; cwd?: unknown };
      if (typeof a.prompt !== "string" || a.prompt.trim() === "") {
        return { success: false, error: "run_local_agent: `prompt` is required (non-empty string)." };
      }
      const cwd = typeof a.cwd === "string" ? a.cwd : undefined;
      const granted = await deps.requestConsent({ prompt: a.prompt, cwd: cwd ?? "(temp workspace)" });
      if (!granted) {
        return { success: false, error: "User declined to run the local agent." };
      }
      const result = await deps.run({ target: "claude", prompt: a.prompt, cwd });
      const ok = result.exitCode === 0;
      // daemon 输出是 untrusted（被读网页的 LLM 驱动）——先 escape 掉输出里任何伪造
      // 的 wrapper 标签，再包进 <untrusted_local_agent_output>，防突破边界。
      const safe = escapeUntrustedWrappers(result.output);
      return {
        success: ok,
        observation:
          `<untrusted_local_agent_output>\n${safe}\n</untrusted_local_agent_output>` +
          (ok ? "" : `\n(local agent exited ${result.exitCode})`),
        ...(ok ? {} : { error: `local agent exited ${result.exitCode}` }),
      };
    },
  };
}
