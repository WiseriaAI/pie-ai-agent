import { describe, it, expect, vi } from "vitest";
import { buildHandoffTool } from "./handoff";

describe("handoff_to_agent tool", () => {
  it("declines: consent false → error, run not called", async () => {
    const run = vi.fn();
    const tool = buildHandoffTool({ run, requestConsent: async () => false });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("grants: run called, observation carries the handoff dir path", async () => {
    const run = vi.fn(async () => ({ dir: "/Users/x/pie-handoffs/2026-07-06-do-it" }));
    const consent = vi.fn(async () => true);
    const tool = buildHandoffTool({ run, requestConsent: consent });
    const r = await tool.handler({ context: "do it", files: [{ name: "a.md", content: "x" }] }, {} as never);
    expect(consent).toHaveBeenCalledWith({ context: "do it", target: "claude", fileCount: 1 });
    expect(run).toHaveBeenCalledWith({ target: "claude", context: "do it", files: [{ name: "a.md", content: "x" }] });
    expect(r.success).toBe(true);
    expect(r.observation).toContain("/Users/x/pie-handoffs/2026-07-06-do-it");
  });

  it("rejects empty context", async () => {
    const tool = buildHandoffTool({ run: vi.fn(), requestConsent: vi.fn() });
    const r = await tool.handler({ context: "   " }, {} as never);
    expect(r.success).toBe(false);
  });
});
