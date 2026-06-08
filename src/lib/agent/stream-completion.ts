import type { StreamEvent } from "@/lib/model-router/types";

type StopReason = Extract<StreamEvent, { type: "done" }>["stopReason"];

export type StreamCompletionKind = "ok" | "truncated-empty" | "truncated-partial";

/**
 * 判定一次 LLM 流式输出的收尾性质，专门识别「被 max_tokens 上限截断」的两种坏情况。
 * 纯函数，无副作用。`stopReason === "length"` 即 provider 报告输出触顶（anthropic-wire
 * 的 max_tokens / openai-compat 的 finish_reason="length" 都映射成它）。
 */
export function classifyStreamCompletion(input: {
  stopReason: StopReason;
  hasToolCalls: boolean;
  hasText: boolean;
}): StreamCompletionKind {
  if (input.stopReason !== "length") return "ok";
  if (input.hasToolCalls) return "ok"; // tool 结果进下一轮，loop 自然继续
  return input.hasText ? "truncated-partial" : "truncated-empty";
}
