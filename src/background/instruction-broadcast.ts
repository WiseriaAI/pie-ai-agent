import { getSessionAgent } from "@/lib/sessions/storage";
import type { ChatInstructionStateMessage } from "@/types/messages";

/**
 * Issue #34 — read current pendingInstructions from storage and broadcast
 * the slim payload (chatMessageId + createdAt only) to the panel via the
 * given emit sink. Centralizes broadcast so callers (add handler, cancel
 * handler, drain in loop, reconnect) all use the same shape.
 *
 * ADR 0002: accepts a generic emit sink so the loop (headless path) can
 * pass ctx.emit directly without a chrome.runtime.Port. Front-end callers
 * pass `(m) => port.postMessage(m)`.
 */
export async function broadcastInstructionState(
  emit: (msg: ChatInstructionStateMessage) => void,
  sessionId: string,
): Promise<void> {
  const state = await getSessionAgent(sessionId);
  const payload: ChatInstructionStateMessage = {
    type: "chat-instruction-state",
    sessionId,
    pending: (state?.pendingInstructions ?? []).map((p) => ({
      chatMessageId: p.chatMessageId,
      createdAt: p.createdAt,
    })),
  };
  try {
    emit(payload);
  } catch (e) {
    console.warn("[sw] broadcastInstructionState emit failed:", e);
  }
}
