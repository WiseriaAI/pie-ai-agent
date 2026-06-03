/**
 * Tests for history-validation.ts (U4 — validateAndRepairAdjacentRoles).
 *
 * Covers all 11 plan-mandated scenarios:
 *   1.  Happy path: [system, user, assistant, user] → no violations
 *   2.  Adjacent user: [system, user, user] → 1 violation + sentinel_assistant inserted
 *   3.  Adjacent assistant: [system, user, assistant, assistant] → 1 violation + sentinel_user inserted
 *   4.  system-system not a violation: [system, system, user] → no violations
 *   5.  Multiple consecutive user: [system, user, user, user] → 2 violations, sentinels inserted
 *   6.  Empty array → throws MultiTurnHistoryError
 *   7.  Sentinel content contains wrapper tag literal (verify string value unchanged)
 *   8.  Integration U2 normal path: SW-side synth output passes validation
 *   9.  Integration U2 skipped synth bug: auto-repair fills gap, user invisible
 *  10.  Telemetry: violations.length > 0 → violations array returned (no raw content)
 *  11.  Regression single-turn: [system, user] → no violations
 */

import { describe, it, expect } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import {
  validateAndRepairAdjacentRoles,
  dropEmptyMessages,
  MultiTurnHistoryError,
} from "./history-validation";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sys(content = "system prompt"): AgentMessage {
  return { role: "system", content };
}

function user(content = "user message"): AgentMessage {
  return { role: "user", content };
}

function assistant(content = "assistant message"): AgentMessage {
  return { role: "assistant", content };
}

/** The sentinel value the function inserts — this is the EXACT literal. */
const SENTINEL =
  "<untrusted_continuity_marker>[continuing previous conversation]</untrusted_continuity_marker>";

// ── Scenario 1 — Happy path ───────────────────────────────────────────────────
describe("Scenario 1: happy path — no violations", () => {
  it("[system, user, assistant, user] → repaired === input, no violations", () => {
    const input: AgentMessage[] = [sys(), user(), assistant(), user("second user")];
    const { repaired, violations } = validateAndRepairAdjacentRoles(input);
    expect(violations).toHaveLength(0);
    // repaired is a new array (not same reference)
    expect(repaired).not.toBe(input);
    // but contents are identical
    expect(repaired).toEqual(input);
  });
});

// ── Scenario 11 — Regression single-turn ─────────────────────────────────────
describe("Scenario 11: regression — single-turn [system, user]", () => {
  it("no violations", () => {
    const input: AgentMessage[] = [sys(), user()];
    const { repaired, violations } = validateAndRepairAdjacentRoles(input);
    expect(violations).toHaveLength(0);
    expect(repaired).toEqual(input);
  });
});

// ── Scenario 2 — Adjacent user ────────────────────────────────────────────────
describe("Scenario 2: adjacent user-user → 1 violation + sentinel_assistant", () => {
  it("inserts assistant sentinel between two adjacent user messages", () => {
    const u1 = user("first");
    const u2 = user("second");
    const input: AgentMessage[] = [sys(), u1, u2];
    const { repaired, violations } = validateAndRepairAdjacentRoles(input);

    expect(violations).toHaveLength(1);
    expect(violations[0].idx).toBe(1); // index of u1 in input
    expect(violations[0].role).toBe("user");

    // repaired: [sys, u1, sentinel_assistant, u2]
    expect(repaired).toHaveLength(4);
    expect(repaired[0]).toEqual(sys());
    expect(repaired[1]).toEqual(u1);
    expect(repaired[2]).toEqual({ role: "assistant", content: SENTINEL });
    expect(repaired[3]).toEqual(u2);
  });
});

// ── Scenario 3 — Adjacent assistant ──────────────────────────────────────────
describe("Scenario 3: adjacent assistant-assistant → 1 violation + sentinel_user", () => {
  it("inserts user sentinel between two adjacent assistant messages", () => {
    const a1 = assistant("first assistant");
    const a2 = assistant("second assistant");
    const input: AgentMessage[] = [sys(), user(), a1, a2];
    const { repaired, violations } = validateAndRepairAdjacentRoles(input);

    expect(violations).toHaveLength(1);
    expect(violations[0].idx).toBe(2); // index of a1 in input
    expect(violations[0].role).toBe("assistant");

    // repaired: [sys, user, a1, sentinel_user, a2]
    expect(repaired).toHaveLength(5);
    expect(repaired[3]).toEqual({ role: "user", content: SENTINEL });
    expect(repaired[4]).toEqual(a2);
  });
});

// ── Scenario 4 — system-system not a violation ───────────────────────────────
describe("Scenario 4: system-system is NOT a violation", () => {
  it("[system, system, user] → 0 violations", () => {
    const input: AgentMessage[] = [sys("s1"), sys("s2"), user()];
    const { repaired, violations } = validateAndRepairAdjacentRoles(input);
    expect(violations).toHaveLength(0);
    expect(repaired).toEqual(input);
  });
});

// ── Scenario 5 — Multiple consecutive user ────────────────────────────────────
describe("Scenario 5: [system, user, user, user] → 2 violations", () => {
  it("inserts sentinels between each adjacent pair", () => {
    const u1 = user("a");
    const u2 = user("b");
    const u3 = user("c");
    const input: AgentMessage[] = [sys(), u1, u2, u3];
    const { repaired, violations } = validateAndRepairAdjacentRoles(input);

    // violations at indices 1 (u1 vs u2) and 2 (u2 vs u3 in INPUT coords)
    expect(violations).toHaveLength(2);
    expect(violations[0].idx).toBe(1);
    expect(violations[1].idx).toBe(2);
    expect(violations[0].role).toBe("user");
    expect(violations[1].role).toBe("user");

    // repaired: [sys, u1, sentinel_a, u2, sentinel_b, u3]
    expect(repaired).toHaveLength(6);
    expect(repaired[0]).toEqual(sys());
    expect(repaired[1]).toEqual(u1);
    expect(repaired[2]).toEqual({ role: "assistant", content: SENTINEL });
    expect(repaired[3]).toEqual(u2);
    expect(repaired[4]).toEqual({ role: "assistant", content: SENTINEL });
    expect(repaired[5]).toEqual(u3);
  });
});

// ── Scenario 6 — Empty array ─────────────────────────────────────────────────
describe("Scenario 6: empty array → throws MultiTurnHistoryError", () => {
  it("throws MultiTurnHistoryError", () => {
    expect(() => validateAndRepairAdjacentRoles([])).toThrow(MultiTurnHistoryError);
  });

  it("error message describes the problem", () => {
    expect(() => validateAndRepairAdjacentRoles([])).toThrow(
      "validateAndRepairAdjacentRoles: received empty message array",
    );
  });
});

// ── Scenario 7 — Sentinel content contains wrapper tag ───────────────────────
describe("Scenario 7: sentinel content contains untrusted wrapper tag literal", () => {
  it("sentinel string is the exact fixed literal (not double-escaped)", () => {
    const input: AgentMessage[] = [sys(), user("a"), user("b")];
    const { repaired } = validateAndRepairAdjacentRoles(input);
    const sentinel = repaired[2] as { role: string; content: string };
    // Must be the exact literal — NOT double-escaped through escapeUntrustedWrappers.
    expect(sentinel.content).toBe(SENTINEL);
    // Verify the wrapper tags are present as raw (not html-entity form).
    expect(sentinel.content).toContain("<untrusted_continuity_marker>");
    expect(sentinel.content).toContain("</untrusted_continuity_marker>");
  });

  it("sentinel uses untrusted_continuity_marker tag, NOT untrusted_prior_task_summary", () => {
    const input: AgentMessage[] = [sys(), user("a"), user("b")];
    const { repaired } = validateAndRepairAdjacentRoles(input);
    const sentinel = repaired[2] as { role: string; content: string };
    // A1 fix: sentinel stub must use a DISTINCT tag from real prior-task synth,
    // so LLM can tell them apart semantically.
    expect(sentinel.content).toContain("untrusted_continuity_marker");
    expect(sentinel.content).not.toContain("untrusted_prior_task_summary");
  });
});

// ── Scenario 8 — Integration U2 normal path ──────────────────────────────────
describe("Scenario 8: integration U2 normal — SW synth injected correctly → no violations", () => {
  it("[system, user, assistant(synth), user] → no violations", () => {
    // Mimics the output of SW-side lastTaskSynth injection (U3):
    // an assistant turn wrapped in <untrusted_prior_task_summary> precedes the new user message.
    const synthContent =
      "<untrusted_prior_task_summary>Previous task completed successfully.</untrusted_prior_task_summary>";
    const input: AgentMessage[] = [
      sys(),
      user("What is 2+2?"),
      assistant(synthContent),
      user("Now what about 3+3?"),
    ];
    const { violations } = validateAndRepairAdjacentRoles(input);
    expect(violations).toHaveLength(0);
  });
});

// ── Scenario 9 — Integration U2 skipped synth bug ────────────────────────────
describe("Scenario 9: integration U2 bug path — synth missing → auto-repair, user invisible", () => {
  it("[system, user, user] (synth omitted) → repaired silently, 1 violation", () => {
    // If the SW-side synth injection had a bug and didn't insert the
    // assistant turn, the history would have two adjacent user messages.
    // validateAndRepairAdjacentRoles must auto-repair without throwing.
    const input: AgentMessage[] = [
      sys(),
      user("First task result"),
      user("New task: do something else"),
    ];
    expect(() => validateAndRepairAdjacentRoles(input)).not.toThrow();
    const { repaired, violations } = validateAndRepairAdjacentRoles(input);
    expect(violations).toHaveLength(1);
    // Repaired array is still valid (no adjacent same-role non-system pairs)
    const nonSys = repaired.filter((m) => m.role !== "system");
    for (let i = 0; i < nonSys.length - 1; i++) {
      expect(nonSys[i].role).not.toBe(nonSys[i + 1].role);
    }
  });
});

// ── Scenario 10 — Telemetry: violations returned without raw content ──────────
describe("Scenario 10: telemetry — violations array returned, no raw content", () => {
  it("violations array contains idx and role but NOT raw message content", () => {
    const input: AgentMessage[] = [
      sys(),
      user("my secret message"),
      user("another message"),
    ];
    const { violations } = validateAndRepairAdjacentRoles(input);
    expect(violations).toHaveLength(1);
    const v = violations[0];
    // Only idx and role exposed — no content field
    expect(v).toHaveProperty("idx");
    expect(v).toHaveProperty("role");
    expect(v).not.toHaveProperty("content");
    expect(v).not.toHaveProperty("rawContent");
    // idx points to the first message of the violating pair in the input
    expect(v.idx).toBe(1);
    expect(v.role).toBe("user");
  });
});

// ── Illegal role ──────────────────────────────────────────────────────────────
describe("illegal role → throws MultiTurnHistoryError", () => {
  it("throws for unknown role value", () => {
    const bad = [{ role: "function" as "user", content: "oops" }] as AgentMessage[];
    expect(() => validateAndRepairAdjacentRoles(bad)).toThrow(MultiTurnHistoryError);
  });
});

// ── Input not mutated ─────────────────────────────────────────────────────────
describe("input array is not mutated", () => {
  it("returns a new array; original is unchanged", () => {
    const u1 = user("a");
    const u2 = user("b");
    const input: AgentMessage[] = [sys(), u1, u2];
    const originalLength = input.length;
    const { repaired } = validateAndRepairAdjacentRoles(input);
    expect(input).toHaveLength(originalLength); // input unchanged
    expect(repaired).not.toBe(input);           // different reference
    expect(repaired.length).toBeGreaterThan(input.length); // sentinel added
  });
});

// ── dropEmptyMessages ─────────────────────────────────────────────────────────
//
// Regression for the Moonshot/Kimi 400 "message at position N with role
// 'assistant' must not be empty". A reasoning-model turn that emitted thinking
// but no visible text (then a tool call) made the panel persist an assistant
// bubble with content "" (buildAssistant only skips when BOTH text AND thinking
// are empty). On the next task that empty assistant string is replayed into the
// LLM history and strict providers (Moonshot) reject it. dropEmptyMessages is
// the provider-agnostic hygiene step that removes such wire-empty messages
// before the LLM call.
describe("dropEmptyMessages", () => {
  it("drops an assistant message with empty-string content (the reported bug)", () => {
    const input: AgentMessage[] = [
      sys(),
      user("first task"),
      assistant(""), // ← reasoning-only turn persisted with no visible text
      user("second task"),
    ];
    const out = dropEmptyMessages(input);
    expect(out).toEqual([sys(), user("first task"), user("second task")]);
  });

  it("drops a whitespace-only assistant message", () => {
    const input: AgentMessage[] = [sys(), user("q"), assistant("   \n  ")];
    const out = dropEmptyMessages(input);
    expect(out).toEqual([sys(), user("q")]);
  });

  it("drops an assistant message whose only block is empty text", () => {
    const input: AgentMessage[] = [
      sys(),
      user("q"),
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ];
    const out = dropEmptyMessages(input);
    expect(out).toEqual([sys(), user("q")]);
  });

  it("keeps an assistant message that carries tool_use blocks (not empty)", () => {
    const toolUse: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "read_page", input: {} },
    ];
    const input: AgentMessage[] = [
      sys(),
      user("q"),
      { role: "assistant", content: toolUse },
    ];
    const out = dropEmptyMessages(input);
    expect(out).toEqual(input);
  });

  it("keeps a user message that carries tool_result blocks (not empty)", () => {
    const toolResult: ContentBlock[] = [
      { type: "tool_result", toolUseId: "t1", content: "ok" },
    ];
    const input: AgentMessage[] = [
      sys(),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: toolResult },
    ];
    const out = dropEmptyMessages(input);
    expect(out).toEqual(input);
  });

  it("keeps a user message that carries an image block (not empty)", () => {
    const img: ContentBlock[] = [
      { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
    ];
    const input: AgentMessage[] = [sys(), { role: "user", content: img }];
    const out = dropEmptyMessages(input);
    expect(out).toEqual(input);
  });

  it("keeps an assistant message whose only block is a thinking block (Anthropic replay safety)", () => {
    const think: ContentBlock[] = [
      { type: "thinking", thinking: "reasoning", signature: "sig" },
    ];
    const input: AgentMessage[] = [
      sys(),
      user("q"),
      { role: "assistant", content: think },
    ];
    const out = dropEmptyMessages(input);
    expect(out).toEqual(input);
  });

  it("never drops the system message", () => {
    // system is always first and always has content; guard against accidental drop.
    const input: AgentMessage[] = [sys(""), user("q")];
    const out = dropEmptyMessages(input);
    expect(out[0]).toEqual(sys(""));
  });

  it("keeps non-empty assistant text untouched", () => {
    const input: AgentMessage[] = [sys(), user("q"), assistant("real reply")];
    const out = dropEmptyMessages(input);
    expect(out).toEqual(input);
  });

  it("returns a new array and does not mutate the input", () => {
    const input: AgentMessage[] = [sys(), user("q"), assistant("")];
    const before = input.length;
    const out = dropEmptyMessages(input);
    expect(input).toHaveLength(before);
    expect(out).not.toBe(input);
  });

  it("composes with validateAndRepairAdjacentRoles: empty assistant dropped, no adjacency left", () => {
    // The exact loop chokepoint order: dropEmptyMessages → validateAndRepairAdjacentRoles.
    const input: AgentMessage[] = [
      sys(),
      user("first task"),
      assistant(""), // dropped → would leave user,user adjacency
      user("second task"),
    ];
    const cleaned = dropEmptyMessages(input);
    const { repaired } = validateAndRepairAdjacentRoles(cleaned);
    // No wire-empty message survives.
    for (const m of repaired) {
      if (m.role === "system") continue;
      if (typeof m.content === "string") {
        expect(m.content.trim().length).toBeGreaterThan(0);
      }
    }
    // No adjacent same-role non-system pairs.
    const nonSys = repaired.filter((m) => m.role !== "system");
    for (let i = 0; i < nonSys.length - 1; i++) {
      expect(nonSys[i].role).not.toBe(nonSys[i + 1].role);
    }
  });
});
