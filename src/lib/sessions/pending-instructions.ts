import type { PendingInstruction, SessionAgentState } from "./types";
import { agentKey, getSessionAgent, writeAtomic } from "./storage";

/**
 * Append a PendingInstruction to the session's queue.
 * Read-modify-write on session_{id}_agent.
 */
export async function addPending(
  sessionId: string,
  instruction: PendingInstruction,
): Promise<void> {
  const state = await getSessionAgent(sessionId);
  if (!state) return;
  const next: SessionAgentState = {
    ...state,
    pendingInstructions: [...state.pendingInstructions, instruction],
  };
  await writeAtomic({ [agentKey(sessionId)]: next });
}

/**
 * Remove a PendingInstruction by chatMessageId. Idempotent — missing id is no-op.
 * Returns true if something was removed.
 */
export async function cancelPending(
  sessionId: string,
  chatMessageId: string,
): Promise<boolean> {
  const state = await getSessionAgent(sessionId);
  if (!state) return false;
  const before = state.pendingInstructions.length;
  const filtered = state.pendingInstructions.filter(
    (p) => p.chatMessageId !== chatMessageId,
  );
  if (filtered.length === before) return false;
  const next: SessionAgentState = { ...state, pendingInstructions: filtered };
  await writeAtomic({ [agentKey(sessionId)]: next });
  return true;
}

/**
 * Read + clear queue atomically. Returns the drained instructions in FIFO order.
 * Caller is responsible for broadcasting the empty state and pushing the merged
 * user message into agentMessages.
 */
export async function drainPending(
  sessionId: string,
): Promise<PendingInstruction[]> {
  const state = await getSessionAgent(sessionId);
  if (!state) return [];
  const drained = state.pendingInstructions;
  if (drained.length === 0) return [];
  const next: SessionAgentState = { ...state, pendingInstructions: [] };
  await writeAtomic({ [agentKey(sessionId)]: next });
  return drained;
}
