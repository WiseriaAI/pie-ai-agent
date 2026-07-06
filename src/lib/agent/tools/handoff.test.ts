import { describe, it, expect, vi } from "vitest";
import { buildHandoffTool } from "./handoff";

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)" },
  { id: "codex-terminal", label: "Codex (Terminal)" },
];

describe("handoff_to_agent tool", () => {
  it("declines: consent null → error, run not called", async () => {
    const run = vi.fn();
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: async () => null });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("grants: consent gets the agent list, run called with the picked id", async () => {
    const run = vi.fn(async () => ({ dir: "/Users/x/pie-handoffs/2026-07-07-do-it", mode: "terminal" as const }));
    const consent = vi.fn(async () => "codex-terminal");
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: consent });
    const r = await tool.handler({ context: "do it", files: [{ name: "a.md", content: "x" }] }, {} as never);
    expect(consent).toHaveBeenCalledWith({ context: "do it", fileCount: 1, agents: AGENTS });
    expect(run).toHaveBeenCalledWith({ target: "codex-terminal", context: "do it", files: [{ name: "a.md", content: "x" }] });
    expect(r.success).toBe(true);
    expect(r.observation).toContain("/Users/x/pie-handoffs/2026-07-07-do-it");
    expect(r.observation).toContain("Codex (Terminal)");
  });

  it("app mode observation tells the LLM the user must send a message to start", async () => {
    const run = vi.fn(async () => ({ dir: "/Users/x/pie-handoffs/2026-07-07-do-it", mode: "app" as const }));
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: async () => "claude-app" });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(true);
    expect(r.observation).toMatch(/send a message/i);
  });

  it("empty detection: structured error, no consent card, no run", async () => {
    const run = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildHandoffTool({ run, listAgents: async () => [], requestConsent });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no supported local agents/i);
    expect(requestConsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects empty context before touching the bridge", async () => {
    const run = vi.fn();
    const listAgents = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildHandoffTool({ run, listAgents, requestConsent });
    const r = await tool.handler({ context: "   " }, {} as never);
    expect(r.success).toBe(false);
    expect(listAgents).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
