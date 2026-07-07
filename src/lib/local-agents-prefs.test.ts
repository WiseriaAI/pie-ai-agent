import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import {
  filterUsableAgents,
  applyToggle,
  getEnabledLocalAgents,
  setEnabledLocalAgents,
} from "./local-agents-prefs";

const DETECTED = [
  { id: "claude-app", label: "Claude Code (App)", installed: true },
  { id: "claude-terminal", label: "Claude Code (Terminal)", installed: false },
  { id: "codex-terminal", label: "Codex (Terminal)", installed: true },
];

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
