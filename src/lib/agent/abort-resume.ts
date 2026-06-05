import type { AgentMessage, ChatMessage } from "@/lib/model-router";
import type { SessionAgentState } from "@/lib/sessions/types";
import { buildMidTaskUserMessage } from "./loop-drain";

export interface AbortResumeSeed {
  resumedAgentMessages: AgentMessage[];
  resumedFromStep: number;
  resumedHasImageContent: boolean;
}

/**
 * B（abort 自动续接，plan: docs/plans/2026-06-06-abort-preserve-history.md Task 2）—
 * 若 session 的 agent 状态是一个 abort 留下的 in-flight 中断点（非空 history +
 * stepIndex>0 + 非 image），返回以完整历史续接的 seed：在保留的 raw agentMessages
 * 末尾追加一条 wrapped user turn（携带用户新消息）。否则返回 null，调用方走正常
 * 新 task 路径。
 *
 * - lastTaskSynth != null → null：synth 是 compress-on-done（success/fail）路径
 *   的产物，不是 abort 中断点；交给 chat-start 的 synth-bridge 处理（abort 不写
 *   synth，故此为 belt-and-suspenders 防御，与 synth-bridge 自我互斥）。
 * - hasImageContent → null：image bytes 不在 storage，无法续接（R14）。
 * - 新消息用 buildMidTaskUserMessage 包成 <untrusted_user_message>，与 #34
 *   drain 注入同一 wrapper（prompt-injection 防御）。
 * - 末尾相邻 user(tool_result)+user(new) 由 loop 的 validateAndRepairAdjacentRoles
 *   合并，无需在此处理。
 */
export function planAbortResumeSeed(
  savedAgent: SessionAgentState | null,
  messages: ChatMessage[],
): AbortResumeSeed | null {
  if (!savedAgent) return null;
  // Defensive: a lastTaskSynth means this was a compress-on-done path (success/
  // fail), not an abort interruption. Never resume over a synth — let chat-start's
  // synth-bridge handle it. abort never writes synth, so this is belt-and-suspenders.
  if (savedAgent.lastTaskSynth != null) return null;
  if (savedAgent.agentMessages.length === 0 || savedAgent.stepIndex <= 0) return null;
  if (savedAgent.hasImageContent) return null;

  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content !== "string") return null;

  // Known limitation: only the text of the continuation message is carried —
  // any `last.attachments` (e.g. a screenshot sent with the continuation) is
  // dropped (the normal non-resume path handles attachments via
  // chatMessageToAgentMessage + hydrateAttachments). Low impact: the attach
  // button is hidden while streaming, so an image continuation mid-task is rare.
  // To support it, build a real PendingInstruction carrying attachments instead.
  const appended = buildMidTaskUserMessage([
    { chatMessageId: "abort-resume", content: last.content, createdAt: 0 },
  ]);
  if (!appended) return null; // unreachable (one item), defensive

  return {
    resumedAgentMessages: [...savedAgent.agentMessages, appended],
    resumedFromStep: savedAgent.stepIndex,
    resumedHasImageContent: savedAgent.hasImageContent,
  };
}
