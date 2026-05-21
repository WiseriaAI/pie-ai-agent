/**
 * Unit U3 (Half B SW-side synth) — D6 / D7 / security-1 / security-2
 *
 * Pure function: given a terminated agent task's metadata, produces a
 * single wrapped string suitable for insertion as an "assistant" turn
 * in the next chat's LLM history, or `null` for pure-text-reply (no
 * action needed — the reply is already an assistant message).
 *
 * Security layers (three-layer defence):
 *   1. Meta-tool blacklist: create_skill / update_skill / delete_skill
 *      args rendered as `<redacted-skill-args>` so promptTemplate /
 *      parameters never surface across task boundaries.
 *   2. `redactArgsForPanel` idempotent: keyboard tool args.text is
 *      stripped before serialization (defence-in-depth; same path as
 *      sendAgentStep).
 *   3. `escapeUntrustedWrappers` per-fragment: each dynamic piece
 *      (summary, step args) is escaped before concatenation so wrapper-
 *      tag literals in page text can't break out of the outer wrapper.
 *
 * Outer wrapper: `<untrusted_prior_task_summary>…</untrusted_prior_task_summary>`
 * Tag is in `UNTRUSTED_WRAPPER_TAGS` (lock-step with snapshot.ts inline
 * regex, asserted by untrusted-wrappers.test.ts fs-read check).
 */

import type { AgentMessage, ContentBlock } from "../model-router/types";
import { escapeUntrustedWrappers } from "./untrusted-wrappers";

/** Termination reason for synthesizeAgentTurnText input. */
export type TerminationReason =
  | "success"
  | "fail"
  | "max-steps"
  | "abort"
  | "pure-text-reply";

export interface SynthesizeAgentTurnInput {
  terminationReason: TerminationReason;
  /** Summary text — done observation for success; error message for
   *  fail; "Max steps reached" for max-steps; fixed cancel string for
   *  abort; ignored for pure-text-reply. */
  summary: string;
  /** Total step count at termination. */
  stepCount: number;
  /** Full history from `ctx.history` in loop.ts — used to extract
   *  tool_use blocks for the step list. */
  history: AgentMessage[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of recent steps shown in fail/max-steps/abort synth. */
const MAX_STEPS_SHOWN = 5;

/** Per-step args string truncation (chars). After escape per D7. */
const MAX_ARG_CHARS = 60;

/** Meta-tools whose args must never cross task boundaries (security-2). */
const META_TOOL_BLACKLIST = new Set(["create_skill", "update_skill", "delete_skill"]);

// ── Redaction helper (mirrors loop.ts redactArgsForPanel) ─────────────────────

/** keyboard-tool name check — matches isKeyboardToolName in loop.ts */
function isKeyboardTool(name: string): boolean {
  return name === "dispatch_keyboard_input" || name === "press_key";
}

function redactArgs(name: string, input: unknown): unknown {
  if (!isKeyboardTool(name)) return input;
  if (!input || typeof input !== "object") return input;
  const a = input as Record<string, unknown>;
  if (typeof a.text !== "string") return input;
  return { ...a, text: undefined, _redactedTextLength: (a.text as string).length };
}

// ── formatStep ────────────────────────────────────────────────────────────────

function formatStep(block: ContentBlock & { type: "tool_use" }): string {
  const name = block.name;

  // security-2 — meta-tool blacklist
  if (META_TOOL_BLACKLIST.has(name)) {
    return `${escapeUntrustedWrappers(name)}(<redacted-skill-args>)`;
  }

  // defense-in-depth: redact keyboard args
  const redacted = redactArgs(name, block.input);
  const raw = JSON.stringify(redacted ?? {});
  // truncate before escape so we don't corrupt entities
  const truncated = raw.length > MAX_ARG_CHARS ? raw.slice(0, MAX_ARG_CHARS) + "…" : raw;
  // escape per D7 — wrapper-tag literals in page-supplied args neutralized
  const safeArgs = escapeUntrustedWrappers(truncated);

  return `${escapeUntrustedWrappers(name)}(${safeArgs})`;
}

// ── formatSteps ───────────────────────────────────────────────────────────────

function formatSteps(history: AgentMessage[]): string {
  const toolUseBlocks: Array<ContentBlock & { type: "tool_use" }> = [];

  for (const msg of history) {
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "tool_use") {
        toolUseBlocks.push(block as ContentBlock & { type: "tool_use" });
      }
    }
  }

  const recent = toolUseBlocks.slice(-MAX_STEPS_SHOWN);
  return recent.map(formatStep).join(" → ");
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Synthesize an assistant turn text for use as `lastTaskSynth` in session
 * meta. Returns `null` for pure-text-reply (caller skips the write).
 *
 * The returned string is already wrapped in
 * `<untrusted_prior_task_summary>…</untrusted_prior_task_summary>`.
 */
export function synthesizeAgentTurnText(
  input: SynthesizeAgentTurnInput,
): string | null {
  const { terminationReason, summary, stepCount, history } = input;

  if (terminationReason === "pure-text-reply") {
    return null;
  }

  // #58(a) — the recent step list is included on ALL non-abort paths,
  // not just fail/max-steps. The one-line summary alone loses what the
  // prior task actually did; carrying the steps lets the next task recall
  // concrete actions (e.g. "read 5 flight prices"). Reuses the same
  // escape + meta-tool blacklist + arg truncation as the fail path.
  const steps = formatSteps(history);
  const stepListPart = steps.length > 0
    ? `\n步骤: ${steps}`
    : "";

  let body: string;

  if (terminationReason === "success") {
    // success path: most information-dense — done observation as summary
    const safeSummary = escapeUntrustedWrappers(summary);
    body = `已完成: ${safeSummary}${stepListPart}`;
  } else {
    // fail / max-steps / abort — include step list + reason
    if (terminationReason === "fail") {
      const safeSummary = escapeUntrustedWrappers(summary);
      body = `[任务失败] ${safeSummary}\n已执行 ${stepCount} 步${stepListPart}`;
    } else if (terminationReason === "max-steps") {
      body = `[任务超步数] 已达 ${stepCount} 步上限${stepListPart}`;
    } else {
      // abort
      const safeSummary = escapeUntrustedWrappers(summary);
      body = `[任务中断] ${safeSummary}`;
    }
  }

  return `<untrusted_prior_task_summary>${body}</untrusted_prior_task_summary>`;
}
