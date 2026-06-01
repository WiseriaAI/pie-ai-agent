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
}

export type RunStatus = "done" | "timeout" | "error" | "harness-error";
