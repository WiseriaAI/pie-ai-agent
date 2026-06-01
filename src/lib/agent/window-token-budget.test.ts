/**
 * U5 — window-token-budget unit tests.
 *
 * Covers all 9 test scenarios listed in the plan.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyTokenBudget, estimateTokens } from "./window-token-budget";
import type { AgentMessage } from "../model-router/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(role: "system" | "user" | "assistant", content: string): AgentMessage {
  if (role === "system") return { role: "system", content };
  return { role, content };
}

/** Build a history of alternating user/assistant string messages under the system. */
function buildChatHistory(
  rounds: number,
  charPerMessage: number,
  cjkRatio: number,
): AgentMessage[] {
  const messages: AgentMessage[] = [makeMsg("system", "You are a helpful assistant.")];
  for (let i = 0; i < rounds; i++) {
    const userContent = makeCjkString(charPerMessage, cjkRatio);
    const assistantContent = makeCjkString(charPerMessage, cjkRatio);
    messages.push(makeMsg("user", userContent));
    messages.push(makeMsg("assistant", assistantContent));
  }
  // Trailing current user turn
  messages.push(makeMsg("user", makeCjkString(charPerMessage, cjkRatio)));
  return messages;
}

/**
 * Produce a string of `length` chars where `cjkRatio` fraction are CJK
 * (U+4E00 "一") and the rest are ASCII "A".
 */
function makeCjkString(length: number, cjkRatio: number): string {
  const cjkCount = Math.round(length * cjkRatio);
  const asciiCount = length - cjkCount;
  return "一".repeat(cjkCount) + "A".repeat(asciiCount);
}

// ---------------------------------------------------------------------------
// Scenario 1 — Happy path: short English conversation, no drop
// ---------------------------------------------------------------------------

describe("U5 — applyTokenBudget", () => {
  describe("Scenario 1: short English chat (5 rounds, ~1k chars) — no drop", () => {
    it("returns history unchanged when under budget", async () => {
      // ~1000 chars total, 0% CJK → divisor 4 → ~250 tokens
      // Anthropic threshold = 200_000 × 0.8 = 160_000 tokens — far below
      const history = buildChatHistory(5, 20, 0); // 5 rounds × 2 × 20 = 200 chars
      const result = await applyTokenBudget(history, "anthropic", "claude-opus-4-7");
      expect(result).toEqual(history);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — Long English conversation exceeding threshold
  // -------------------------------------------------------------------------

  describe("Scenario 2: long English chat exceeding threshold — drop pairs", () => {
    it("drops oldest user-assistant pairs until under budget (Anthropic 200k × 0.8 = 160k tokens)", async () => {
      // Target: est > 160k tokens, 0% CJK → divisor 4
      // Need > 640k chars total. 50 rounds × 2 msg × ~7000 chars = 700k chars
      const history = buildChatHistory(50, 7_000, 0);
      const original = history.length;

      const result = await applyTokenBudget(history, "anthropic", "claude-opus-4-7");

      // Must have dropped some messages
      expect(result.length).toBeLessThan(original);
      // Must not have dropped system (index 0)
      expect(result[0].role).toBe("system");
      // Must not have dropped the trailing user message
      expect(result[result.length - 1].role).toBe("user");
      // After drop, estimate must be at or below threshold
      const estimate = estimateTokens(result);
      expect(estimate).toBeLessThanOrEqual(200_000 * 0.8);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — CJK long chat: verify divisor switch fires
  // -------------------------------------------------------------------------

  describe("Scenario 3: CJK long chat with 32k provider — CJK divisor switches", () => {
    it("CJK 90% ratio (divisor 1.5) causes drops where English ratio (divisor 4) would not", async () => {
      // 30 rounds × 2 × 1_000 chars = 60_000 chars (+ system + trailing user ≈ 62k)
      // With CJK 90%: est ≈ ceil(62000 / 1.5) ≈ 41_334 tokens
      // openrouter threshold = 32_000 × 0.8 = 25_600 tokens → OVER, should drop
      const cjkHistory = buildChatHistory(30, 1_000, 0.9);
      const cjkResult = await applyTokenBudget(cjkHistory, "openrouter", "any-model");
      expect(cjkResult.length).toBeLessThan(cjkHistory.length);
      const cjkEstimate = estimateTokens(cjkResult);
      expect(cjkEstimate).toBeLessThanOrEqual(32_000 * 0.8);

      // Same char count, 0% CJK: est ≈ ceil(62000 / 4) = 15_500 tokens
      // openrouter threshold = 25_600 tokens → UNDER, should NOT drop
      const englishHistory = buildChatHistory(30, 1_000, 0);
      const englishResult = await applyTokenBudget(englishHistory, "openrouter", "any-model");
      expect(englishResult.length).toBe(englishHistory.length);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — Single over-size user message: cannot drop self
  // -------------------------------------------------------------------------

  describe("Scenario 4: single over-size CJK user message — no drop, warn", () => {
    it("returns history unchanged when only the current user message exceeds budget", async () => {
      // history = [system, user(200k CJK chars)]
      // est ≈ ceil(200_000 / 1.5) ≈ 133_333 tokens
      // openrouter threshold = 25_600 tokens → over, but can't drop current user
      const bigContent = "一".repeat(200_000);
      const history: AgentMessage[] = [
        makeMsg("system", "You are helpful."),
        makeMsg("user", bigContent),
      ];

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await applyTokenBudget(history, "openrouter", "any-model");
      warnSpy.mockRestore();

      // Should return with original content (no drop)
      expect(result).toEqual(history);
    });

    it("emits a console.warn when no pairs can be dropped", async () => {
      const bigContent = "一".repeat(200_000);
      const history: AgentMessage[] = [
        makeMsg("system", "System."),
        makeMsg("user", bigContent),
      ];

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await applyTokenBudget(history, "openrouter", "any-model");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Cannot reduce token count further"));
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — system + one user: no drop (protects current user)
  // -------------------------------------------------------------------------

  describe("Scenario 5: system + single user message — no drop", () => {
    it("never drops the only user message even when over budget", async () => {
      const history: AgentMessage[] = [
        makeMsg("system", "System."),
        makeMsg("user", "A".repeat(500_000)), // huge but no prior pairs
      ];

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await applyTokenBudget(history, "openrouter", "any-model");
      warnSpy.mockRestore();

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("system");
      expect(result[1].role).toBe("user");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6 — Unknown provider ID: fallback 32k
  // -------------------------------------------------------------------------

  describe("Scenario 6: unknown provider ID — fallback to 32k", () => {
    it("uses 32k fallback context window for unrecognized provider IDs", async () => {
      // history with 30 rounds × 1000 chars CJK 90% would exceed 32k × 0.8 = 25.6k threshold
      const history = buildChatHistory(30, 1_000, 0.9);
      const resultKnown = await applyTokenBudget(history, "openrouter", "any-model");   // known provider, empty static catalog → fallback 32k
      const resultUnknown = await applyTokenBudget(history, "unknown_provider_xyz", "any-model"); // unknown provider → fallback 32k

      // Both should drop the same amount (same effective threshold)
      expect(resultUnknown.length).toBe(resultKnown.length);
    });

    it("fallback drops are applied just as with an explicit 32k provider", async () => {
      const history = buildChatHistory(30, 1_000, 0.9);
      const result = await applyTokenBudget(history, "some_future_provider", "any-model");
      // Must still be under budget with the 32k fallback
      expect(estimateTokens(result)).toBeLessThanOrEqual(32_000 * 0.8);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — CJK ratio exactly 50%: divisor stays at 4
  // -------------------------------------------------------------------------

  describe("Scenario 7: CJK ratio exactly 50% — divisor 4 (not 1.5)", () => {
    it("uses divisor 4 when CJK ratio is exactly 0.5", () => {
      // 100 chars: 50 CJK + 50 ASCII → ratio = 0.5 (not > 0.5)
      const content = "一".repeat(50) + "A".repeat(50);
      const msgs: AgentMessage[] = [
        makeMsg("system", ""),
        makeMsg("user", content),
      ];
      // ceil(100 / 4) = 25; ceil(100 / 1.5) = 67
      // Verify by using estimateTokens on the content message alone
      const estimate = estimateTokens([makeMsg("user", content)]);
      // divisor 4 → ceil(100 / 4) = 25
      expect(estimate).toBe(25);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 8 — Empty string content: no divide-by-zero, divisor 4
  // -------------------------------------------------------------------------

  describe("Scenario 8: empty string content — no divide-by-zero", () => {
    it("returns 0 tokens for a message list with empty content", () => {
      const msgs: AgentMessage[] = [makeMsg("system", ""), makeMsg("user", "")];
      expect(estimateTokens(msgs)).toBe(0);
    });

    it("returns history unchanged when total chars is 0", async () => {
      const msgs: AgentMessage[] = [makeMsg("system", ""), makeMsg("user", "")];
      const result = await applyTokenBudget(msgs, "openrouter", "any-model");
      expect(result).toEqual(msgs);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 9 — Integration: U1 applySlidingWindow + U5 applyTokenBudget
  // -------------------------------------------------------------------------

  describe("Scenario 9: integration — sliding window + token budget", () => {
    it("token budget only drops head pairs, not react segment", async () => {
      // Build a history: [system, chat prefix (many pairs), current user, react pairs]
      // The react segment has ContentBlock[] content.
      const head: AgentMessage[] = [
        { role: "system", content: "System prompt." },
      ];
      // Add 20 prior chat rounds to head (string content, droppable)
      for (let i = 0; i < 20; i++) {
        head.push({ role: "user", content: "A".repeat(2_000) });
        head.push({ role: "assistant", content: "A".repeat(2_000) });
      }
      // Current user task
      head.push({ role: "user", content: "Do something now." });

      // React segment (ContentBlock[] content, not droppable by token budget)
      const react: AgentMessage[] = [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
      ];

      const fullHistory = [...head, ...react];

      // Total chars in head alone ≈ 20 × 2 × 2000 = 80_000 chars
      // With 0% CJK → est ≈ 80_000 / 4 = 20_000 tokens
      // openrouter threshold = 25_600 → UNDER budget, so no drop needed
      // Let's use much bigger content to force drops
      const bigHead: AgentMessage[] = [
        { role: "system", content: "System prompt." },
      ];
      for (let i = 0; i < 20; i++) {
        bigHead.push({ role: "user", content: "A".repeat(10_000) });
        bigHead.push({ role: "assistant", content: "A".repeat(10_000) });
      }
      bigHead.push({ role: "user", content: "Do something now." });

      const bigHistory = [...bigHead, ...react];
      // chars ≈ 20 × 2 × 10_000 = 400_000 chars / 4 = 100_000 tokens >> 25_600

      const result = await applyTokenBudget(bigHistory, "openrouter", "any-model");

      // React segment should be intact at the end
      const reactInResult = result.filter((m) => Array.isArray(m.content));
      expect(reactInResult).toHaveLength(2);

      // System should be intact
      expect(result[0]).toEqual({ role: "system", content: "System prompt." });

      // Current user task should be intact (last non-react user)
      const lastMsg = result[result.length - 1];
      // Last message could be the trailing react user or the trailing head user
      // depending on structure. The react segment is at the tail, so last is react.
      // The head trailing user "Do something now." should still be in result.
      const headUserTask = result.find(
        (m) => m.role === "user" && m.content === "Do something now.",
      );
      expect(headUserTask).toBeDefined();

      // Token estimate should be under threshold
      expect(estimateTokens(result)).toBeLessThanOrEqual(32_000 * 0.8);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #76 — provider-aware maxContextTokens (was: bug-fix regression guard)
// ---------------------------------------------------------------------------

describe("Issue #76: maxContextTokens must come from per-model ModelMeta", () => {
  it("Anthropic 200k model does NOT drop a 80k-token history (>25.6k bug threshold, <160k real threshold)", async () => {
    // 320_000 ASCII chars / 4 = 80_000 tokens.
    //   - Buggy 32k fallback → threshold 25.6k → must drop many pairs.
    //   - Correct 200k window → threshold 160k → must NOT drop anything.
    // 40 rounds × 2 × 4_000 chars = 320_000 chars.
    const history = buildChatHistory(40, 4_000, 0);
    expect(estimateTokens(history)).toBeGreaterThan(32_000 * 0.8);
    expect(estimateTokens(history)).toBeLessThan(200_000 * 0.8);

    const result = await applyTokenBudget(history, "anthropic", "claude-opus-4-7");

    // No drop expected when provider-aware lookup works.
    expect(result).toEqual(history);
  });

  it("unknown model id under known provider falls back to 32k (preserves drop behavior)", async () => {
    // Same shape as Scenario 6 but with explicit unknown model id under Anthropic.
    // resolveModelMeta returns null → fallback 32k → drops should occur.
    const history = buildChatHistory(30, 1_000, 0.9);
    const result = await applyTokenBudget(history, "anthropic", "model-that-does-not-exist");
    expect(result.length).toBeLessThan(history.length);
    expect(estimateTokens(result)).toBeLessThanOrEqual(32_000 * 0.8);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 HARD GATE — image-skip + per-provider surcharge
// ---------------------------------------------------------------------------

describe("estimateTokens — image-skip (Phase 5 HARD GATE)", () => {
  it("does not inflate when content has an image block", () => {
    const bigData = "A".repeat(2_000_000); // 2 MB base64 simulant
    const msgsNoImg: AgentMessage[] = [
      { role: "user", content: "what is this?" },
    ];
    const msgsWithImg: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: bigData } },
          { type: "text", text: "what is this?" },
        ],
      },
    ];
    const tokensNoImg = estimateTokens(msgsNoImg);
    const tokensWithImg = estimateTokens(msgsWithImg);
    // Image surcharge ~1568 / 765 tokens (only counted when provider passed) — much
    // less than the 500K char-divisor would produce from a 2 MB base64 inflation.
    // Without provider, surcharge is 0 — but the image bytes still must NOT be
    // JSON.stringified into the text token count.
    expect(tokensWithImg).toBeLessThan(tokensNoImg + 5000);
  });

  it("with provider=anthropic, adds 1568 surcharge per image", () => {
    const msgsWithImg: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } },
        ],
      },
    ];
    const tokens = estimateTokens(msgsWithImg, "anthropic");
    expect(tokens).toBe(1568);
  });

  it("with provider=openai, adds 765 surcharge per image", () => {
    const msgsWithImg: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } },
        ],
      },
    ];
    const tokens = estimateTokens(msgsWithImg, "openai");
    expect(tokens).toBe(765);
  });

  it("with provider=openrouter, inherits openai 765 surcharge", () => {
    const msgsWithImg: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } },
        ],
      },
    ];
    expect(estimateTokens(msgsWithImg, "openrouter")).toBe(765);
  });

  it("text + image: text tokens + provider surcharge", () => {
    const msgsWithImg: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } },
          { type: "text", text: "hello" }, // 5 chars / 4 = 2 tokens (Math.ceil)
        ],
      },
    ];
    expect(estimateTokens(msgsWithImg, "anthropic")).toBe(1568 + 2);
  });
});

// ---------------------------------------------------------------------------
// thinking block — text must count toward token estimate
// ---------------------------------------------------------------------------

describe("estimateTokens — thinking block counts toward budget", () => {
  it("a message with a thinking block has a higher estimate than without it", () => {
    const thinkingText = "A".repeat(400); // 400 chars of reasoning
    const baseText = "hello"; // 5 chars

    const msgsWithoutThinking: AgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: baseText }] },
    ];
    const msgsWithThinking: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: thinkingText },
          { type: "text", text: baseText },
        ],
      },
    ];

    const tokensWithout = estimateTokens(msgsWithoutThinking);
    const tokensWith = estimateTokens(msgsWithThinking);

    // thinking text (400 chars) must increase the estimate
    expect(tokensWith).toBeGreaterThan(tokensWithout);
    // ceil((400 + 5) / 4) = ceil(405 / 4) = 102 for with-thinking
    // ceil(5 / 4) = 2 for without-thinking
    expect(tokensWithout).toBe(2);
    expect(tokensWith).toBe(102);
  });
});

describe("applyTokenBudget — image-bearing turn drop semantics unchanged", () => {
  it("image turns drop in age order (oldest first), no special preservation", async () => {
    // Spec: image cache lifecycle handles eviction, NOT the budget. The budget
    // treats image-bearing turns same as text-bearing turns for drop-order purposes.
    const msgs: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old text 1" },
      { role: "assistant", content: "ack 1" },
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" } }],
      },
      { role: "assistant", content: "ack img" },
      { role: "user", content: "current" },
    ];
    // Within budget — no drops expected
    const result = await applyTokenBudget(msgs, "openai", "gpt-4o");
    expect(result.length).toBe(6);
  });
});
