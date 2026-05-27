import { agentKey } from "@/lib/sessions/storage";
import type { SessionAgentState } from "@/lib/sessions/types";
import type { ChatInstructionStateMessage } from "@/types/messages";

/**
 * Issue #34 — read current pendingInstructions from storage and broadcast
 * the slim payload (chatMessageId + createdAt only) to the panel via the
 * given port. Centralizes broadcast so callers (add handler, cancel handler,
 * drain in loop, reconnect) all use the same shape.
 */
export async function broadcastInstructionState(
  port: chrome.runtime.Port,
  sessionId: string,
): Promise<void> {
  const key = agentKey(sessionId);
  const res = await chrome.storage.local.get(key);
  const state = res[key] as SessionAgentState | undefined;
  const payload: ChatInstructionStateMessage = {
    type: "chat-instruction-state",
    sessionId,
    pending: (state?.pendingInstructions ?? []).map((p) => ({
      chatMessageId: p.chatMessageId,
      createdAt: p.createdAt,
    })),
  };
  try {
    port.postMessage(payload);
  } catch (e) {
    console.warn("[sw] broadcastInstructionState postMessage failed:", e);
  }
}
