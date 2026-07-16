import { describe, it, expect, vi } from "vitest";
import { buildRunLocalAgentTool } from "./local-agent";

const BACKENDS = [
  { id: "claude-terminal", label: "Claude Code (Terminal)" },
  { id: "codex-terminal", label: "Codex (Terminal)" },
];

describe("run_local_agent tool", () => {
  it("declined consent (null) → returns failure observation, does not run", async () => {
    const run = vi.fn();
    const tool = buildRunLocalAgentTool({
      run,
      listBackends: async () => BACKENDS,
      requestConsent: async () => null,
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("no headless backends installed → failure, does not open a card or run", async () => {
    const run = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildRunLocalAgentTool({
      run,
      listBackends: async () => [],
      requestConsent,
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(requestConsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the backend the user picked on the card (not necessarily the first)", async () => {
    const run = vi.fn(async () => ({
      output: "CODEX DID X",
      exitCode: 0,
      cwd: "/tmp/x",
      backend: { id: "codex-terminal", label: "Codex (Terminal)" },
    }));
    const tool = buildRunLocalAgentTool({
      run,
      listBackends: async () => BACKENDS,
      // 用户在卡上选了 codex
      requestConsent: async () => "codex-terminal",
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(run).toHaveBeenCalledWith({ target: "codex-terminal", prompt: "do it", cwd: undefined });
    expect(r.success).toBe(true);
    expect(r.observation).toContain("CODEX DID X");
  });

  it("passes the installed headless backends to the consent card", async () => {
    const requestConsent = vi.fn(async () => "claude-terminal");
    const run = vi.fn(async () => ({ output: "X", exitCode: 0, cwd: "/tmp/x" }));
    const tool = buildRunLocalAgentTool({ run, listBackends: async () => BACKENDS, requestConsent });
    await tool.handler({ prompt: "do it", cwd: "/proj" }, { tabId: 1 } as never);
    expect(requestConsent).toHaveBeenCalledWith({
      prompt: "do it",
      cwd: "/proj",
      agents: BACKENDS,
    });
  });

  it("names the backend in the observation when daemon reports it", async () => {
    const run = vi.fn(async () => ({
      output: "CODEX DID X",
      exitCode: 0,
      cwd: "/tmp/x",
      backend: { id: "codex-terminal", label: "Codex (Terminal)" },
    }));
    const tool = buildRunLocalAgentTool({
      run,
      listBackends: async () => BACKENDS,
      requestConsent: async () => "codex-terminal",
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(r.observation).toContain("ran via Codex (Terminal)");
    expect(r.observation).toContain("CODEX DID X");
  });

  it("omits the backend line when daemon does not report one (old daemon)", async () => {
    const run = vi.fn(async () => ({ output: "X", exitCode: 0, cwd: "/tmp/x" }));
    const tool = buildRunLocalAgentTool({
      run,
      listBackends: async () => BACKENDS,
      requestConsent: async () => "claude-terminal",
    });
    const r = await tool.handler({ prompt: "do it" }, { tabId: 1 } as never);
    expect(r.observation).not.toContain("ran via");
  });

  it("missing prompt → validation error", async () => {
    const tool = buildRunLocalAgentTool({
      run: vi.fn(),
      listBackends: vi.fn(),
      requestConsent: vi.fn(),
    });
    const r = await tool.handler({}, { tabId: 1 } as never);
    expect(r.success).toBe(false);
  });
});
