import type { RunLocalAgentParams, RunLocalAgentResult } from "../../src/types/local-bridge";

export async function runLocalAgent(params: RunLocalAgentParams): Promise<RunLocalAgentResult> {
  return { output: "", exitCode: 0, cwd: "" };
}
