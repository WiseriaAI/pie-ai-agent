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
import type { AgentMessage, ContentBlock, ModelConfig } from "../model-router/types";
import { streamChat } from "../model-router";
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
  const reactStartIdx = findReactStartIdx(history);
  if (reactStartIdx === -1) return;

  // react 段按 2 条一对(交替不变式保证;尾部奇数条不参与)。
  const reactLen = history.length - reactStartIdx;
  const pairCount = Math.floor(reactLen / 2);
  if (pairCount === 0) return;

  // 已压缩区:开头连续的合成对(user 含 tag)。
  let compactedCount = 0;
  while (
    compactedCount < pairCount &&
    isCompactedUserMsg(history[reactStartIdx + compactedCount * 2 + 1])
  ) {
    compactedCount++;
  }

  // 可压原始对数 = 总对 - 已压缩 - 保鲜。
  const maxCompactable = pairCount - compactedCount - KEEP_RECENT;
  if (maxCompactable <= 0) return;

  const victimStart = reactStartIdx + compactedCount * 2;

  // 逐对累积 victim,直到「移除后」elide 估算达标,或可压对耗尽。
  let victimPairs = 0;
  while (victimPairs < maxCompactable) {
    victimPairs++;
    const candidate = [
      ...history.slice(0, victimStart),
      ...history.slice(victimStart + victimPairs * 2),
    ];
    if (estimateTokens(elideStaleObservations(candidate)) <= threshold) break;
  }

  const victimMsgs = history.slice(victimStart, victimStart + victimPairs * 2);
  if (signal.aborted) return;
  const summary = await summarizer(victimMsgs, signal);
  if (signal.aborted || summary === null) return; // 本步跳过,history 不变

  const synthetic = buildSyntheticPair(summary, victimPairs);
  history.splice(victimStart, victimPairs * 2, ...synthetic);
}

/** 构造一个合成对:可信 assistant 占位 + untrusted user 摘要(含 tag、已 escape)。 */
function buildSyntheticPair(summary: string, pairs: number): AgentMessage[] {
  const safe = escapeUntrustedWrappers(summary);
  return [
    {
      role: "assistant",
      content: [{ type: "text", text: `[早期 ${pairs} 对步骤已压缩为摘要]` }],
    },
    {
      role: "user",
      content: [{ type: "text", text: `<${COMPACTED_TAG}>\n${safe}\n</${COMPACTED_TAG}>` }],
    },
  ];
}

/** 把一条步骤 message 转成可读 transcript 行(只取 text / tool_use 名/args / tool_result 文本,丢弃 image)。 */
function serializeStepMsg(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content;
  const parts: string[] = [];
  for (const b of msg.content as ContentBlock[]) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "tool_use") parts.push(`Action: ${b.name}(${JSON.stringify(b.input)})`);
    else if (b.type === "tool_result") parts.push(`Result: ${b.content}`);
  }
  return parts.join("\n");
}

const COMPACTION_SYSTEM =
  "你在压缩一个网页 AI agent 的早期步骤。用两个带标签的部分简洁总结,不要别的内容:\n" +
  "动作: 依次执行了哪些动作;\n" +
  "发现: 页面上观察到的关键数据/数值/进度(保留具体数字、价格、ID、表单进度)。\n" +
  "省略 DOM 元素列表。尽量简短。";

/** 纯函数:把待压步骤对拼成 compaction 用的 LLM 消息序列。 */
export function buildCompactionMessages(pairs: AgentMessage[]): AgentMessage[] {
  const transcript = pairs.map(serializeStepMsg).join("\n");
  return [
    { role: "system", content: COMPACTION_SYSTEM },
    { role: "user", content: `以下是早期步骤记录,请按两部分格式压缩总结:\n\n${transcript}` },
  ];
}

/** 默认 summarizer:用当前 model 跑无 tool streamChat,收集纯文本(模式同 generateStuckSummary)。 */
export function createDefaultSummarizer(modelConfig: ModelConfig): ReactSummarizer {
  return async (pairs, signal) => {
    if (signal.aborted) return null;
    const msgs = buildCompactionMessages(pairs);
    let text = "";
    try {
      for await (const ev of streamChat(modelConfig, msgs, signal, [])) {
        if (signal.aborted) return null;
        if (ev.type === "text-delta") text += ev.text;
        else if (ev.type === "error") return null;
      }
    } catch {
      return null;
    }
    const t = text.trim();
    return t.length > 0 ? t : null;
  };
}
