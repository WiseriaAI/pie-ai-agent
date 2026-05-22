/**
 * #58 子点 b — 任务内 react 段 LLM compaction。
 *
 * compactReactWindow 是有状态的 IN-PLACE 重写:超 token 阈值时把最旧的
 * react 步骤经注入的 summarizer 摘成一个「合成对」(assistant 占位 + user
 * untrusted 摘要),splice 替换进 history 数组本身。合成对 append-only 累积,
 * 持久化由调用方的 onStepSnapshot(structuredClone(history))承担。
 *
 * 与 elide/budget(无状态 wire-time 副本)不同:compaction 含 LLM 调用,
 * 每轮重算会贵且非确定,故 in-place 持久化、压一次缓存住。
 */
import type { AgentMessage, ContentBlock } from "../model-router/types";
import { findReactStartIdx } from "./window";
import { estimateTokens } from "./window-token-budget";
import { elideStaleObservations } from "./elide-stale-observations";
import { escapeUntrustedWrappers } from "./untrusted-wrappers";

/** 注入式摘要器:输入待压缩的步骤对,返回 untrusted 摘要正文;null = 失败/abort/空。 */
export type ReactSummarizer = (
  pairs: AgentMessage[],
  signal: AbortSignal,
) => Promise<string | null>;

/** 保鲜区下限:最近 KEEP_RECENT 对原始步骤永不压缩。 */
const KEEP_RECENT = 4;
/** 触发阈值比例,复用 applyTokenBudget 的 80%。 */
const THRESHOLD_RATIO = 0.8;
/** 合成对 user 那条携带的标记 tag,用于识别已压缩区。 */
const COMPACTED_TAG = "untrusted_compacted_steps";

/** user message 是否为合成对的摘要条(含 COMPACTED_TAG)。 */
export function isCompactedUserMsg(msg: AgentMessage): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return (msg.content as ContentBlock[]).some(
    (b) => b.type === "text" && b.text.includes(`<${COMPACTED_TAG}>`),
  );
}

export async function compactReactWindow(
  history: AgentMessage[],
  maxContextTokens: number,
  summarizer: ReactSummarizer,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const threshold = maxContextTokens * THRESHOLD_RATIO;
  // 用 elide 后的等效大小判定,与最终实际发送量一致。
  if (estimateTokens(elideStaleObservations(history)) <= threshold) return;
  // 触发逻辑在循环 B 实现。
}
