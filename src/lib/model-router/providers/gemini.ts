// src/lib/model-router/providers/gemini.ts (stub — Task 5 implements)
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";

export async function* streamChat(
  _config: ModelConfig,
  _messages: AgentMessage[],
  _signal?: AbortSignal,
  _tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield { type: "error", error: "Gemini provider not yet implemented (Task 5)" };
}
