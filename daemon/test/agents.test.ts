import { test, expect } from "bun:test";
import { AGENT_CANDIDATES, detectAgents } from "../src/agents";

test("candidate table: exactly three first-batch agents, app first (preselect order)", () => {
  expect(AGENT_CANDIDATES.map((c) => c.id)).toEqual(["claude-app", "claude-terminal", "codex-terminal"]);
  // launch 权威字段齐备：terminal 有 bin，app 有 appPath+appName
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "terminal") expect(c.bin).toBeDefined();
    else {
      expect(c.appPath).toBeDefined();
      expect(c.appName).toBeDefined();
    }
  }
});

test("detectAgents filters by injected which/exists, preserving table order", () => {
  // 只装了 codex CLI + Claude app，没装 claude CLI
  const detected = detectAgents({
    which: (bin) => (bin === "codex" ? "/opt/homebrew/bin/codex" : null),
    exists: (p) => p === "/Applications/Claude.app",
  });
  expect(detected.map((c) => c.id)).toEqual(["claude-app", "codex-terminal"]);
});

test("detectAgents returns empty when nothing installed", () => {
  expect(detectAgents({ which: () => null, exists: () => false })).toEqual([]);
});
