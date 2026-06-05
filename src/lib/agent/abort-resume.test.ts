import { describe, it, expect } from "vitest";
import { planAbortResumeSeed } from "./abort-resume";
import type { SessionAgentState } from "@/lib/sessions/types";
import type { ChatMessage } from "@/lib/model-router";

function agent(overrides: Partial<SessionAgentState> = {}): SessionAgentState {
  return {
    agentMessages: [
      { role: "system", content: "sys" },
      { role: "user", content: "<untrusted_user_message>do X</untrusted_user_message>" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
    pendingInstructions: [],
    stepIndex: 2,
    hasImageContent: false,
    ...overrides,
  } as SessionAgentState;
}

const newMsg: ChatMessage[] = [
  { role: "user", content: "actually, also do Y" },
];

describe("planAbortResumeSeed", () => {
  it("returns resume seed when agent has in-flight history (stepIndex>0, non-empty)", () => {
    const seed = planAbortResumeSeed(agent(), newMsg);
    expect(seed).not.toBeNull();
    expect(seed!.resumedFromStep).toBe(2);
    expect(seed!.resumedHasImageContent).toBe(false);
    const last = seed!.resumedAgentMessages.at(-1)!;
    expect(last.role).toBe("user");
    expect(typeof last.content === "string" && last.content).toContain("also do Y");
    expect(seed!.resumedAgentMessages.length).toBe(agent().agentMessages.length + 1);
  });

  it("returns null when agentMessages is empty (no in-flight history)", () => {
    expect(planAbortResumeSeed(agent({ agentMessages: [] }), newMsg)).toBeNull();
  });

  it("returns null when stepIndex is 0 (tombstone / fresh)", () => {
    expect(planAbortResumeSeed(agent({ stepIndex: 0 }), newMsg)).toBeNull();
  });

  it("returns null when savedAgent is null", () => {
    expect(planAbortResumeSeed(null, newMsg)).toBeNull();
  });

  it("returns null when hasImageContent (image not resumable — R14)", () => {
    expect(planAbortResumeSeed(agent({ hasImageContent: true }), newMsg)).toBeNull();
  });

  it("returns null when last message is not a user string", () => {
    expect(planAbortResumeSeed(agent(), [{ role: "assistant", content: "x" }])).toBeNull();
  });
});
