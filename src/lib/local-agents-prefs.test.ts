import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import {
  isAgentUsable,
  filterUsableAgents,
  filterHeadlessBackends,
  applyToggle,
  getEnabledLocalAgents,
  setEnabledLocalAgents,
} from "./local-agents-prefs";

const DETECTED = [
  { id: "claude-app", label: "Claude Code (App)", installed: true },
  { id: "claude-terminal", label: "Claude Code (Terminal)", installed: false },
  { id: "codex-terminal", label: "Codex (Terminal)", installed: true },
];

describe("isAgentUsable (shared predicate: settings enabled 标注与 handoff 过滤的唯一真源)", () => {
  it("installed + null prefs → usable; not installed → never usable", () => {
    expect(isAgentUsable(DETECTED[0], null)).toBe(true);
    expect(isAgentUsable(DETECTED[1], null)).toBe(false);
    expect(isAgentUsable(DETECTED[1], ["claude-terminal"])).toBe(false);
  });
  it("explicit prefs gate installed agents", () => {
    expect(isAgentUsable(DETECTED[0], ["codex-terminal"])).toBe(false);
    expect(isAgentUsable(DETECTED[2], ["codex-terminal"])).toBe(true);
  });
});

describe("filterUsableAgents", () => {
  it("null prefs = every installed agent usable (out-of-box default)", () => {
    expect(filterUsableAgents(DETECTED, null).map((a) => a.id)).toEqual(["claude-app", "codex-terminal"]);
  });
  it("explicit prefs intersect with installed", () => {
    expect(filterUsableAgents(DETECTED, ["codex-terminal"]).map((a) => a.id)).toEqual(["codex-terminal"]);
  });
  it("not-installed never usable even if listed in prefs", () => {
    expect(filterUsableAgents(DETECTED, ["claude-terminal"])).toEqual([]);
  });
});

describe("filterHeadlessBackends (run_local_agent 卡片后端预筛)", () => {
  const HEADLESS_DETECTED = [
    { id: "claude-app", label: "Claude Code (App)", installed: true, kind: "app" as const, headless: false },
    { id: "claude-terminal", label: "Claude Code (Terminal)", installed: true, kind: "terminal" as const, headless: true },
    { id: "codex-terminal", label: "Codex (Terminal)", installed: false, kind: "terminal" as const, headless: true },
  ];

  it("keeps only installed ∩ enabled ∩ headless (app forms excluded)", () => {
    // claude-app installed 但 headless:false → 排除；codex-terminal headless 但未装 → 排除
    expect(filterHeadlessBackends(HEADLESS_DETECTED, null).map((a) => a.id)).toEqual(["claude-terminal"]);
  });

  it("respects enable prefs", () => {
    expect(filterHeadlessBackends(HEADLESS_DETECTED, ["claude-app"])).toEqual([]);
  });

  it("falls back to kind === terminal when daemon omits headless flag (old daemon)", () => {
    const oldDaemon = [
      { id: "claude-app", label: "Claude Code (App)", installed: true, kind: "app" as const },
      { id: "pi-terminal", label: "Pi (Terminal)", installed: true, kind: "terminal" as const },
    ];
    expect(filterHeadlessBackends(oldDaemon, null).map((a) => a.id)).toEqual(["pi-terminal"]);
  });
});

describe("applyToggle", () => {
  it("enabling a not-installed agent is rejected", () => {
    expect(applyToggle(DETECTED, null, "claude-terminal", true)).toEqual({ ok: false, reason: "not_installed" });
  });
  it("first toggle materializes null prefs as all-installed, then applies", () => {
    expect(applyToggle(DETECTED, null, "codex-terminal", false)).toEqual({ ok: true, next: ["claude-app"] });
  });
  it("re-enabling adds without duplicates", () => {
    expect(applyToggle(DETECTED, ["claude-app"], "codex-terminal", true)).toEqual({
      ok: true,
      next: ["claude-app", "codex-terminal"],
    });
  });
  it("disabling is allowed regardless of installed state", () => {
    expect(applyToggle(DETECTED, ["claude-app", "claude-terminal"], "claude-terminal", false)).toEqual({
      ok: true,
      next: ["claude-app"],
    });
  });
});

describe("getEnabledLocalAgents / setEnabledLocalAgents (config-store)", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("returns null when never set", async () => {
    expect(await getEnabledLocalAgents()).toBe(null);
  });

  it("round-trips a set list", async () => {
    await setEnabledLocalAgents(["claude-app", "codex-terminal"]);
    expect(await getEnabledLocalAgents()).toEqual(["claude-app", "codex-terminal"]);
  });
});
