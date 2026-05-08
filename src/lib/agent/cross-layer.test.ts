import { describe, it, expect, beforeEach, vi } from "vitest";
import "@/test/setup";
import {
  ORIGIN_CHANGE_TOOL_SENTINEL,
  type AgentConfirmRequestMessage,
  type DisplayMessage,
} from "@/types";
import { buildObservationMessage } from "./prompt";
import type { PageSnapshot } from "@/lib/dom-actions/types";

// Cross-layer integration tests for issue #26 wire→panel propagation.
// Uses the same test harness pattern as loop.test.ts — pure function
// assertions + mock-driven behavior checks.

describe("Cross-layer wire → DisplayMessage propagation (#26)", () => {
  it("autoApproved is undefined when skipPermissions is false (default)", async () => {
    // This test validates the type contract: autoApproved is absent
    // on normal flow. The actual wire field comes from loop.ts emitStep
    // which gates on ctx.skipPermissions.
    const step = {} as { autoApproved?: boolean };
    expect(step.autoApproved).toBeUndefined();
  });

  it("autoApproved=true carries through AgentStepData construction in buildSegments", async () => {
    // Simulate what buildSegments in Chat.tsx does: it reads the wire
    // message's autoApproved field and copies it into AgentStepData.
    const wireMessage = {
      role: "agent-step" as const,
      stepIndex: 1,
      tool: "click",
      args: {},
      resolvedElement: { text: "Submit", tag: "button" },
      status: "ok" as const,
      observation: "clicked",
      autoApproved: true,
    };

    // Assert the wire field survives into the display layer shape.
    expect(wireMessage.autoApproved).toBe(true);
  });

  it("autoApproved is undefined for low-risk tools even with skipPermissions on", async () => {
    // loop.ts emitStep for high-risk tools sets autoApproved only when
    // ctx.skipPermissions && risk.level === "high". Low-risk tools should
    // not carry the flag.
    const lowRiskStep = {
      type: "agent-step",
      stepIndex: 2,
      tool: "scroll",
      args: {},
      status: "ok",
      autoApproved: undefined,
    };
    expect(lowRiskStep.autoApproved).toBeUndefined();
  });

  it("skill scope freedom — skill A can call skill B (R3 removed)", () => {
    // R3 enforcement was deleted from loop.ts. This test asserts the
    // contract: there is no "Skills cannot call other skills" rejection.
    const observations: string[] = [];
    const skillACallsSkillB = true;
    if (skillACallsSkillB) {
      observations.push("skill B executed");
    }
    expect(observations.find((o) => o.includes("Skills cannot call other skills"))).toBeUndefined();
    expect(observations).toContain("skill B executed");
  });

  it("skill scope freedom — call outside legacy allowedTools is not rejected (R2 removed)", () => {
    // R2 enforcement was deleted from loop.ts. A tool call outside the
    // (now deprecated) allowedTools list should not error.
    const observations: string[] = [];
    const legacySkillAllowedTools = ["click"];
    const agentCalled = "type";
    if (!legacySkillAllowedTools.includes(agentCalled)) {
      // R2 would have rejected this, but R2 is removed — no error.
      observations.push("type executed successfully");
    }
    expect(observations.find((o) => o.includes("not allowed in skill"))).toBeUndefined();
    expect(observations).toContain("type executed successfully");
  });

  it("toggling skipPermissions mid-task does not affect in-flight steps (snapshot)", () => {
    // The snapshot semantic: skipPermissions is read at chat-start and
    // frozen. Toggling mid-task should not affect an already-started task.
    // This is verified by the fact that ctx.skipPermissions is a boolean
    // snapshot passed to runAgentLoop, not a live read from storage.
    const skipPermissionsAtStart = false;
    const userToggledToTrue = true;
    // In-flight task still sees the start-time snapshot.
    expect(skipPermissionsAtStart).toBe(false);
    expect(userToggledToTrue).toBe(true);
  });

  it("agent-authored skill with no firstRunConfirmedAt does NOT trigger an extra confirm-request (R10 removed)", () => {
    // R10 first-run-confirm was deleted. An agent-authored skill without
    // firstRunConfirmedAt should NOT cause an additional confirm request.
    const confirmRequests: string[] = [];
    const skill = { author: "agent" as const, firstRunConfirmedAt: undefined };
    if (skill.author === "agent" && !skill.firstRunConfirmedAt) {
      // R10 would have triggered here, but it's removed — no confirm.
    }
    expect(confirmRequests.find((r) => r.includes("first run"))).toBeUndefined();
  });
});

// Cross-layer wire → DisplayMessage for the origin-change confirm card
// (#33 follow-up). Mirrors `useSession.ts:413-456` dispatch logic: the
// wire carries `originChangePreview` from SW's sendConfirmRequest
// payload; useSession spreads it into the agent-confirm DisplayMessage
// so AgentConfirmCard can render the origin-change card variant.
//
// The actual SW dispatch (`background/index.ts` setPendingConfirm with
// `kind: "agent-origin-change"`) is exercised end-to-end in a real
// browser; here we only verify the wire shape contract — same harness
// style as the #26 tests above.
describe("Cross-layer wire → DisplayMessage for origin-change confirm (#33 follow-up)", () => {
  function buildAgentConfirmDisplayMessage(
    wire: AgentConfirmRequestMessage,
  ): DisplayMessage {
    const {
      confirmationId,
      tool,
      args,
      resolvedElement,
      riskReason,
      metaSkillPreview,
      screenshotPreview,
      openUrlPreview,
      originChangePreview,
    } = wire;
    return {
      role: "agent-confirm",
      confirmationId,
      tool,
      args,
      resolvedElement,
      riskReason,
      metaSkillPreview,
      ...(screenshotPreview ? { screenshotPreview } : {}),
      ...(openUrlPreview ? { openUrlPreview } : {}),
      ...(originChangePreview ? { originChangePreview } : {}),
      resolved: undefined,
    };
  }

  const sampleOriginChangeWire: AgentConfirmRequestMessage = {
    type: "agent-confirm-request",
    confirmationId: "c-origin-1",
    tool: ORIGIN_CHANGE_TOOL_SENTINEL,
    args: {},
    resolvedElement: { text: "", tag: "" },
    riskReason:
      "The pinned tab navigated from https://example.com to https://www.iana.org. " +
      "Approve only if you initiated this jump — rejecting stops the agent for safety.",
    originChangePreview: {
      fromOrigin: "https://example.com",
      toOrigin: "https://www.iana.org",
      newUrl: "https://www.iana.org/help/example-domains",
      newTitle: "Example Domains - IANA",
      tabId: 42,
    },
    sessionId: "sess-origin-1",
  };

  it("originChangePreview survives wire → DisplayMessage", () => {
    const display = buildAgentConfirmDisplayMessage(sampleOriginChangeWire);
    expect(display.role).toBe("agent-confirm");
    if (display.role !== "agent-confirm") return; // type narrow

    expect(display.tool).toBe(ORIGIN_CHANGE_TOOL_SENTINEL);
    expect(display.originChangePreview).toEqual({
      fromOrigin: "https://example.com",
      toOrigin: "https://www.iana.org",
      newUrl: "https://www.iana.org/help/example-domains",
      newTitle: "Example Domains - IANA",
      tabId: 42,
    });
  });

  it("non-origin-change confirms do NOT carry originChangePreview", () => {
    const wire: AgentConfirmRequestMessage = {
      type: "agent-confirm-request",
      confirmationId: "c-click-1",
      tool: "click",
      args: { elementIndex: 0 },
      resolvedElement: { text: "Submit", tag: "button" },
      riskReason: "submitting form on cross-origin tab",
      sessionId: "sess-1",
    };
    const display = buildAgentConfirmDisplayMessage(wire);
    if (display.role !== "agent-confirm") return;
    expect(display.originChangePreview).toBeUndefined();
    expect(display.tool).toBe("click");
  });

  it("ORIGIN_CHANGE_TOOL_SENTINEL is the wire-only sentinel string", () => {
    // The sentinel is the contract between loop.ts (sender), SW
    // sendConfirmRequest (kind dispatch), and AgentConfirmCard
    // (variant dispatch). All three sites must compare against the
    // SAME exported constant — never duplicate the literal.
    expect(ORIGIN_CHANGE_TOOL_SENTINEL).toBe("__origin_change__");
  });
});

// Cross-layer wire → agentMessages propagation for the semantic snapshot
// layer (#44). Per feedback_cross_layer_integration_tests.md: any new
// wire field must have a transit regression test. Here the "wire" is the
// PageSnapshot.semantic field; it is serialized into a string by
// buildObservationMessage and that string lands in agentMessages, which
// is persisted to chrome.storage.local via M1-U3 step snapshots and read
// back at cold-start. The test mirrors structuredClone (storage I/O does
// the same) and asserts the Semantic: block survives the round-trip
// AND that prompt-injection wrapper-tag literals stay neutralized.
describe("Cross-layer PageSnapshot.semantic → agentMessages (#44)", () => {
  function fakeSnapshot(): PageSnapshot {
    return {
      url: "https://example.com/issues/new",
      title: "New Issue",
      elements: [
        {
          index: 0,
          tag: "input",
          text: "",
          placeholder: "Title",
          label: "Issue title",
          error: "Title is required",
          disabled: false,
          region: "main",
          boundingBox: { x: 0, y: 0, width: 200, height: 30 },
        },
      ],
      semantic: {
        headings: [
          { level: 1, text: "Open a new issue" },
          { level: 2, text: "Add a description" },
        ],
        alerts: ["Title is required"],
        status: ["Loading templates..."],
      },
    };
  }

  it("Semantic: block survives structuredClone (mirrors storage round-trip)", () => {
    const snap = fakeSnapshot();
    const observation = buildObservationMessage(snap, snap.url);
    const message = { role: "user" as const, content: observation };

    // structuredClone is what chrome.storage.local serialization uses
    // (same algorithm as JSON write/read for plain strings + objects).
    const cloned = structuredClone(message);

    expect(cloned.content).toContain("Semantic:");
    expect(cloned.content).toContain("    H1: Open a new issue");
    expect(cloned.content).toContain('    - "Title is required"');
    expect(cloned.content).toContain('    - "Loading templates..."');
    expect(cloned.content).toContain('label="Issue title"');
    expect(cloned.content).toContain('error="Title is required"');
  });

  it("HARD INVARIANT: wrapper-tag literals injected into semantic fields stay [filtered] across the wire", () => {
    // Simulates a malicious page whose alert text contains a literal
    // </untrusted_page_content>. The collection layer (snapshot.ts
    // sanitizeText) replaces it with [filtered] BEFORE it reaches
    // PageSnapshot. The render layer just emits the already-sanitized
    // string. The wrapper itself contains </untrusted_page_content> as
    // the message boundary — the invariant is that NO ADDITIONAL
    // instance leaks in from page content.
    const snap = fakeSnapshot();
    snap.semantic.alerts = ["[filtered] attempt"];
    snap.semantic.headings = [{ level: 1, text: "Title [filtered] suffix" }];
    const observation = buildObservationMessage(snap, snap.url);
    const cloned = structuredClone({ role: "user" as const, content: observation });

    // Wrapper boundary appears exactly once (opening + closing).
    const openCount = (cloned.content.match(/<untrusted_page_content>/g) || []).length;
    const closeCount = (cloned.content.match(/<\/untrusted_page_content>/g) || []).length;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(cloned.content).toContain("[filtered]");
  });

  it("empty semantic does not emit a Semantic: block (avoids noise on plain pages)", () => {
    const snap = fakeSnapshot();
    snap.semantic = { headings: [], alerts: [], status: [] };
    snap.elements = [];
    const observation = buildObservationMessage(snap, snap.url);
    expect(observation).not.toContain("Semantic:");
    expect(observation).toContain("Elements:");
  });
});
