export interface HarHeader { name: string; value: string }
export interface HarEntry {
  request: { url: string; headers: HarHeader[] };
  response: { headers: HarHeader[] };
  [k: string]: unknown;
}
export interface Har { log: { entries: HarEntry[]; [k: string]: unknown }; [k: string]: unknown }

export interface TaskDef {
  taskId: string;
  goal: string;
  startUrl: string;
  evalType: "info-seeking" | "state-changing";
  /** WebArena host 白名单,用于 HAR 过滤(如 ["shop.webarena.local"])。 */
  webarenaHosts: string[];
}

export interface EvalTrace {
  sessionId: string;
  agentSelfReport: { success: boolean; summary: string };
  answer: string;
  steps: Array<{ stepIndex: number; tool: string; argsRedacted: unknown; status: string }>;
  usage: { inputTokens: number; outputTokens: number };
  startedAt: number;
  endedAt: number;
  error: string | null;
  /** 完整原始 agent 会话(LLM IR:system/user/assistant + tool 调用 + 观测结果),
   *  来自 runAgentLoop 的 onStepSnapshot。用于离线诊断 agent 行为/优化。可能很大,
   *  orchestrator 把它单独写到 agent-trace.json,不进精简的 run.json。 */
  agentMessages?: unknown[];
}

export type RunStatus = "done" | "timeout" | "error" | "harness-error";
