/**
 * slash.ts — Task 9 adapted these helpers from SkillPackage (nested
 * `.frontmatter.name`) to SkillEntry (flat `.name`/`.author`), since Chat.tsx
 * — the only consumer — now sources its skill list from the RPC channel
 * (panel-actions.ts), which returns SkillEntry, not SkillPackage.
 *
 * No test file existed for this module before; these lock in the field-
 * access rewrite (findSkillBySlashKey / resolveSlashCommand / expandSlashCommand
 * over flat SkillEntry fields) plus the pre-existing tie-break and legacy-form
 * behavior so the adaptation didn't silently change semantics.
 */

import { describe, it, expect } from "vitest";
import {
  findSkillBySlashKey,
  resolveSlashCommand,
  expandSlashCommand,
} from "./slash";
import type { SkillEntry } from "./source";

function entry(overrides: Partial<SkillEntry> & { id: string; name: string }): SkillEntry {
  return {
    description: "",
    builtIn: false,
    origin: "idb",
    files: [],
    runnableScripts: [],
    ...overrides,
  };
}

const EXTRACT = entry({ id: "skill_agent_1", name: "Extract Structured Data", builtIn: true, origin: "builtin" });
const USER_SKILL = entry({ id: "skill_user_2", name: "My Custom Thing" });

describe("findSkillBySlashKey", () => {
  it("matches by exact id", () => {
    expect(findSkillBySlashKey([EXTRACT, USER_SKILL], "skill_user_2")).toBe(USER_SKILL);
  });

  it("matches by normalized slug of the flat .name field", () => {
    expect(findSkillBySlashKey([EXTRACT, USER_SKILL], "extract-structured-data")).toBe(EXTRACT);
    expect(findSkillBySlashKey([EXTRACT, USER_SKILL], "my_custom_thing")).toBe(USER_SKILL);
  });

  it("returns null when nothing matches", () => {
    expect(findSkillBySlashKey([EXTRACT, USER_SKILL], "nonexistent")).toBeNull();
  });

  it("tie-breaks same-slug collisions user > agent > built-in", () => {
    const builtin = entry({ id: "skill_a", name: "Report", builtIn: true, origin: "builtin" });
    const agent = entry({ id: "skill_b", name: "Report", builtIn: false, author: "agent" });
    const user = entry({ id: "skill_c", name: "Report", builtIn: false, author: "user" });
    // Order in the input list shouldn't matter — rank alone decides.
    expect(findSkillBySlashKey([builtin, agent, user], "report")).toBe(user);
    expect(findSkillBySlashKey([builtin, agent], "report")).toBe(agent);
  });
});

describe("resolveSlashCommand", () => {
  const skills = [EXTRACT, USER_SKILL];

  it("resolves the shorthand /<key> form with trailing args as rest", () => {
    const match = resolveSlashCommand("/extract-structured-data col1,col2", skills);
    expect(match?.skill).toBe(EXTRACT);
    expect(match?.rest).toBe("col1,col2");
  });

  it("resolves the legacy /skill <key> [rest] form identically", () => {
    const match = resolveSlashCommand("/skill skill_user_2 extra", skills);
    expect(match?.skill).toBe(USER_SKILL);
    expect(match?.rest).toBe("extra");
  });

  it("returns null for unrecognized slash text (caller passes raw text through)", () => {
    expect(resolveSlashCommand("/something_unrelated", skills)).toBeNull();
  });

  it("returns null for non-slash text", () => {
    expect(resolveSlashCommand("hello", skills)).toBeNull();
  });
});

describe("expandSlashCommand", () => {
  it("renders the flat .name (not .frontmatter.name) into the instruction", () => {
    const out = expandSlashCommand({ skill: USER_SKILL, rest: "" });
    expect(out).toBe(
      'Use the "My Custom Thing" skill (id: skill_user_2) by invoking the use_skill tool with that id, then follow its instructions.',
    );
  });

  it("appends the user's extra input when rest is non-empty", () => {
    const out = expandSlashCommand({ skill: USER_SKILL, rest: "do it fast" });
    expect(out.endsWith("Additional input from the user: do it fast")).toBe(true);
  });
});
