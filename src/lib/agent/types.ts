import type { PageSnapshot, ActionResult } from "../dom-actions/types";

export type RiskLevel = "low" | "high";

export interface RiskAssessment {
  level: RiskLevel;
  reason?: string;
}

export interface ToolHandlerContext {
  tabId: number;
  snapshot: PageSnapshot;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  riskHint: "low" | "high" | "context";
  handler: (args: unknown, ctx: ToolHandlerContext) => Promise<ActionResult>;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: unknown;
  result?: ActionResult;
  riskAssessment: RiskAssessment;
}

export type AgentStepStatus = "pending" | "ok" | "error" | "rejected";

export interface AgentStep {
  stepIndex: number;
  toolCall: ToolCallRecord;
  status: AgentStepStatus;
}
