/**
 * U4 — validateAndRepairAdjacentRoles
 *
 * Defense-in-depth guard inserted between history construction and the
 * modelRouter.chat call. Anthropic's Messages API rejects 400 when two
 * consecutive messages share the same role (user-user or
 * assistant-assistant). The D2 SW-side synth and U2 wrapping layers
 * already ensure correct alternation on normal paths; this repair layer
 * is the last resort for wire-format bugs or future refactor gaps.
 *
 * system-system pairs are intentionally NOT counted as violations:
 * anthropic.ts:13-26 already joins multiple system messages into the
 * top-level `system` field, so consecutive system entries never reach
 * the provider as adjacent role peers.
 *
 * True hard-error paths (empty input, illegal role value) throw
 * `MultiTurnHistoryError` — those indicate a bug in the caller's
 * construction logic that cannot be auto-repaired.
 */

import type { AgentMessage } from "../model-router/types";

const VALID_ROLES = new Set(["system", "user", "assistant"]);

/** Thrown only on truly unrecoverable input (empty array or illegal role). */
export class MultiTurnHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiTurnHistoryError";
  }
}

export interface RoleViolation {
  /** Index of the FIRST message in the violating adjacent pair (0-based,
   *  into the INPUT array before any repair insertion). */
  idx: number;
  /** The shared role value ("user" or "assistant"). */
  role: "user" | "assistant";
}

export interface RepairResult {
  repaired: AgentMessage[];
  violations: RoleViolation[];
}

/**
 * True when `msg` would serialize to an empty message on the wire — no text,
 * no tool_use, no tool_result, no image, and no thinking block. Strict
 * providers (e.g. Moonshot/Kimi) reject `{role:"assistant", content:""}` with
 * a 400 ("message at position N with role 'assistant' must not be empty");
 * lenient providers silently tolerate it.
 *
 * thinking blocks count as meaningful so Anthropic extended-thinking signature
 * replay is never broken by the drop pass.
 */
function isWireEmpty(msg: AgentMessage): boolean {
  const content = msg.content;
  if (typeof content === "string") return content.trim() === "";
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim() !== "") return false;
    } else {
      // tool_use / tool_result / image / thinking — always meaningful.
      return false;
    }
  }
  return true;
}

/**
 * Remove wire-empty non-system messages from the history.
 *
 * Root-cause fix for the Moonshot/Kimi 400 empty-assistant error: a
 * reasoning-model turn that emitted thinking but no visible text (then a tool
 * call) makes the panel persist an assistant bubble with content "" (the
 * panel's buildAssistant only skips when BOTH text AND thinking are empty).
 * On the next task that empty assistant string is replayed into the LLM
 * history; the thinking was already stripped before it got here, so the
 * message carries zero information and removing it is loss-free.
 *
 * Provider-agnostic by design (the user's requirement: "even if other
 * providers don't error, there shouldn't be empty messages") and heals
 * already-persisted sessions because it runs in the loop on every call.
 *
 * Runs BEFORE `validateAndRepairAdjacentRoles` so any same-role adjacency the
 * removal creates (e.g. user, <dropped assistant>, user) is repaired by the
 * sentinel insertion that follows. system messages are never dropped. Input
 * is not mutated (returns a new array).
 */
export function dropEmptyMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => m.role === "system" || !isWireEmpty(m));
}

/**
 * Sentinel content inserted between two adjacent messages of the same role.
 *
 * The content is a plain literal — NOT passed through escapeUntrustedWrappers
 * because it is trusted, fixed, code-generated text (not user-supplied).
 * The wrapper tag signals to the LLM that this is synthetic context.
 */
const SENTINEL_CONTENT =
  "<untrusted_continuity_marker>[continuing previous conversation]</untrusted_continuity_marker>";

function sentinelFor(role: "user" | "assistant"): AgentMessage {
  // Insert the OPPOSITE role between two messages of the same role.
  const insertRole: "user" | "assistant" = role === "user" ? "assistant" : "user";
  return { role: insertRole, content: SENTINEL_CONTENT };
}

/**
 * Validate and, if necessary, repair an AgentMessage array so that no two
 * adjacent non-system messages share the same role.
 *
 * @param messages - The history to validate (e.g. result of applySlidingWindow).
 * @returns `{ repaired, violations }` — `repaired` is a NEW array (input
 *   not mutated); `violations` lists each detected pair (by input index).
 * @throws {MultiTurnHistoryError} if `messages` is empty or contains an
 *   entry with an unrecognised role value.
 */
export function validateAndRepairAdjacentRoles(messages: AgentMessage[]): RepairResult {
  if (messages.length === 0) {
    throw new MultiTurnHistoryError(
      "validateAndRepairAdjacentRoles: received empty message array",
    );
  }

  // Validate roles first (full pass) so we can throw early before any repair.
  for (let i = 0; i < messages.length; i++) {
    if (!VALID_ROLES.has(messages[i].role)) {
      throw new MultiTurnHistoryError(
        `validateAndRepairAdjacentRoles: illegal role "${messages[i].role}" at index ${i}`,
      );
    }
  }

  const violations: RoleViolation[] = [];
  const repaired: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    repaired.push(messages[i]);

    const curr = messages[i];
    const next = messages[i + 1];

    // No next message — nothing to compare.
    if (!next) continue;

    // system-system pairs are not violations (anthropic.ts joins them).
    if (curr.role === "system" || next.role === "system") continue;

    if (curr.role === next.role && (curr.role === "user" || curr.role === "assistant")) {
      violations.push({ idx: i, role: curr.role });
      // Insert sentinel between the two adjacent same-role messages.
      repaired.push(sentinelFor(curr.role));
    }
  }

  return { repaired, violations };
}
