import { describe, expect, it } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import { buildSessionAgentSnapshot } from "./loop";

// M1-U3 invariant tests — focused on the snapshot helper, not the full
// agent loop. The full loop is too tightly coupled to Chrome APIs +
// model router to mock economically; the helper carries the two key
// M1-U3 invariants (D4 deep clone and R28 v2 storage-holds-raw) so
// testing it in isolation buys us the most coverage per line.
//
// End-to-end "snapshot fires N times for N-step task" is verified
// manually in browser per the plan's Verification section.

describe("buildSessionAgentSnapshot", () => {
  it("returns the correct shape with stepIndex passed through", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "do the thing" },
    ];
    const snap = buildSessionAgentSnapshot(history, 1);
    expect(snap).toEqual({
      agentMessages: history,
      stepIndex: 1,
      skillExecutionScopeStack: [],
    });
  });

  it("stepIndex maps semantically to 'completed steps' (matches SessionAgentState JSDoc)", () => {
    // M1-U1 SessionAgentState seeds stepIndex=0 at createSession. After
    // the first step completes, snapshot fires with stepIndex=1. So a
    // freshly-mounted hook reading stepIndex>0 is the M1-U5 signal that
    // a task was in flight when the SW died.
    const history: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "obs" }] },
    ];
    expect(buildSessionAgentSnapshot(history, 1).stepIndex).toBe(1);
    expect(buildSessionAgentSnapshot(history, 7).stepIndex).toBe(7);
  });

  it("D4 — agentMessages is a deep clone, not a reference (in-place mutation safety)", () => {
    // The agent loop mutates history's trailing user message in place
    // each round (observation merge at loop body around line ~587). If
    // the snapshot held a reference, the persisted state would silently
    // mutate after we wrote it, drifting away from the step it
    // represents. structuredClone breaks the alias.
    const initialContent: ContentBlock[] = [
      { type: "text", text: "task" },
    ];
    const history: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: initialContent },
    ];

    const snap = buildSessionAgentSnapshot(history, 1);

    // Mutate the SAME object the loop would mutate — both the array
    // and the inner block.
    (initialContent as ContentBlock[]).push({
      type: "text",
      text: "appended-after-snapshot",
    });
    (initialContent[0] as { text: string }).text = "tampered-after-snapshot";

    // The snapshot's user message must be untouched.
    const snapUserMsg = snap.agentMessages[1]!;
    expect(snapUserMsg.role).toBe("user");
    expect(Array.isArray(snapUserMsg.content)).toBe(true);
    const blocks = snapUserMsg.content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "text", text: "task" });

    // And the original was indeed mutated (sanity check that we tested
    // the right thing).
    expect(history[1]!.content).toHaveLength(2);
  });

  it("D4 — replacing a content array on the original does not leak into the snapshot", () => {
    // The loop's observation-merge code at loop.ts:587 reassigns
    // `lastMsg.content = [...new array...]`. This replaces the
    // *reference* on the original message. structuredClone copies the
    // top-level message object too, so this kind of swap also can't
    // affect the snapshot.
    const history: AgentMessage[] = [
      { role: "user", content: "original-task" },
    ];

    const snap = buildSessionAgentSnapshot(history, 1);

    history[0]!.content = [
      { type: "text", text: "task" },
      { type: "text", text: "observation" },
    ];

    expect(snap.agentMessages[0]!.content).toBe("original-task");
  });

  it("R28 v2 — keyboard tool_use args.text is stored RAW (no panel-display redaction)", () => {
    // R28 v2 reinterpretation (plan D7 / M1-U3 Approach): storage holds
    // raw agentMessages so M1-U5 resume can give the LLM full context;
    // panel-display redaction happens via redactArgsForPanel on a
    // SEPARATE code path (sendAgentStep → AgentStepMessage), never on
    // the snapshot path. Test it: a CDP keyboard tool_use with a
    // plaintext "password" must come out of the snapshot helper with
    // the password intact.
    const history: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "fill the form" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "dispatch_keyboard_input",
            input: { text: "password123" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tu_1",
            content: "ok",
          },
        ],
      },
    ];

    const snap = buildSessionAgentSnapshot(history, 1);

    const assistantBlocks = snap.agentMessages[2]!.content as ContentBlock[];
    const toolUse = assistantBlocks[0] as {
      type: "tool_use";
      input: { text: string };
    };
    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.input.text).toBe("password123");
    // Specifically not a redacted form like "[redacted]" or "•••".
    expect(toolUse.input.text).not.toContain("redacted");
    expect(toolUse.input.text).not.toContain("•");
  });

  it("skillExecutionScopeStack is empty in M1 (M2-U1 will populate)", () => {
    const history: AgentMessage[] = [
      { role: "user", content: "task" },
    ];
    const snap = buildSessionAgentSnapshot(history, 1);
    expect(snap.skillExecutionScopeStack).toEqual([]);
  });

  it("does NOT set pendingConfirm on the snapshot", () => {
    // pendingConfirm is M1-U4's responsibility — its lifecycle is
    // SW-alive only and gets written by the confirm dispatch path,
    // not the per-step snapshot path. Setting it here would
    // accidentally clobber a real pending-confirm record on the
    // very next step boundary.
    const history: AgentMessage[] = [
      { role: "user", content: "task" },
    ];
    const snap = buildSessionAgentSnapshot(history, 1);
    expect(snap.pendingConfirm).toBeUndefined();
    expect("pendingConfirm" in snap).toBe(false);
  });
});
