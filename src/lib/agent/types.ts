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
  handler: (args: unknown, ctx: ToolHandlerContext) => Promise<ActionResult>;
}
