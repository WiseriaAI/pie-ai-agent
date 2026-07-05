import { describe, it, expect, vi } from "vitest";
import { buildRunLocalAgentTool } from "./local-agent";

describe("run_local_agent tool", () => {
  it("denied consent → returns failure observation, does not run", async () => {
    const run = vi.fn();
    const tool = buildRunLocalAgentTool({
      run,
      requestConsent: async () => false,
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("granted consent → runs and returns output as observation", async () => {
    const run = vi.fn(async () => ({ output: "AGENT DID X", exitCode: 0, cwd: "/tmp/x" }));
    const tool = buildRunLocalAgentTool({
      run,
      requestConsent: async () => true,
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(run).toHaveBeenCalledWith({ target: "claude", prompt: "do it", cwd: undefined });
    expect(r.success).toBe(true);
    expect(r.observation).toContain("AGENT DID X");
  });

  it("missing prompt → validation error", async () => {
    const tool = buildRunLocalAgentTool({ run: vi.fn(), requestConsent: vi.fn() });
    const r = await tool.handler({}, { tabId: 1 } as never);
    expect(r.success).toBe(false);
  });
});
