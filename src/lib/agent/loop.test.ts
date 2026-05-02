import { describe, expect, it } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import type { SessionAgentState } from "@/lib/sessions/types";
import {
  buildSessionAgentSnapshot,
  buildSessionAgentTombstone,
} from "./loop";

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

  it("M1-U3 v2 tombstone — empty history + stepIndex 0 + empty scope stack", () => {
    // Tombstone is the 'no in-flight task' marker written by emitDone.
    // M1-U5 cold-start reads stepIndex > 0 as the in-flight signal;
    // without this clear, stale state from a long-completed task
    // would falsely flag the session as paused on next SW boot.
    const tombstone = buildSessionAgentTombstone();
    expect(tombstone).toEqual({
      agentMessages: [],
      stepIndex: 0,
      skillExecutionScopeStack: [],
    });
  });

  it("M1-U3 v2 tombstone — independent calls return independent objects", () => {
    // Defensive: callers shouldn't be able to mutate one tombstone and
    // accidentally affect the next. The function returns a fresh object
    // each call.
    const a = buildSessionAgentTombstone();
    const b = buildSessionAgentTombstone();
    expect(a).not.toBe(b);
    expect(a.agentMessages).not.toBe(b.agentMessages);
    expect(a.skillExecutionScopeStack).not.toBe(b.skillExecutionScopeStack);
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

  // M2-U1 — skillExecutionScopeStack passed through to snapshot
  it("M2-U1 — skillExecutionScopeStack is passed through to snapshot", () => {
    const history: AgentMessage[] = [{ role: "user", content: "task" }];
    const stack: SessionAgentState["skillExecutionScopeStack"] = [
      { skillId: "my_skill", allowedTools: ["click", "type"] },
    ];
    const snap = buildSessionAgentSnapshot(history, 3, stack);
    expect(snap.skillExecutionScopeStack).toEqual(stack);
    expect(snap.stepIndex).toBe(3);
  });

  it("M2-U1 — skillExecutionScopeStack defaults to [] when not passed (existing callers unaffected)", () => {
    const history: AgentMessage[] = [{ role: "user", content: "task" }];
    // Called with only 2 args — must still work (backward compat for
    // the 9 existing tests above that call buildSessionAgentSnapshot with 2 args).
    const snap = buildSessionAgentSnapshot(history, 1);
    expect(snap.skillExecutionScopeStack).toEqual([]);
  });

  it("M2-U1 — skillExecutionScopeStack is deep-cloned (mutation of input does not leak)", () => {
    const history: AgentMessage[] = [{ role: "user", content: "task" }];
    const stack: SessionAgentState["skillExecutionScopeStack"] = [
      { skillId: "skill_a", allowedTools: ["click"] },
    ];
    const snap = buildSessionAgentSnapshot(history, 1, stack);

    // Mutate the original stack and its inner allowedTools array.
    stack[0]!.skillId = "tampered";
    (stack[0]!.allowedTools as string[]).push("type");
    stack.push({ skillId: "extra", allowedTools: null });

    // Snapshot must be unaffected.
    expect(snap.skillExecutionScopeStack).toHaveLength(1);
    expect(snap.skillExecutionScopeStack[0]!.skillId).toBe("skill_a");
    expect(snap.skillExecutionScopeStack[0]!.allowedTools).toEqual(["click"]);
  });

  it("M2-U1 — tombstone still emits empty skillExecutionScopeStack", () => {
    const tombstone = buildSessionAgentTombstone();
    expect(tombstone.skillExecutionScopeStack).toEqual([]);
  });
});

// ── M2-U1: multi-session stack isolation smoke test ──────────────────────────
//
// The goal is to ensure that two concurrent runAgentLoop invocations
// each use their own independent skill-scope stack. Since runAgentLoop
// is too tightly coupled to Chrome APIs to mock in unit tests, we
// validate the isolation property at the only publicly-testable level:
// by verifying that buildSessionAgentSnapshot carries the stack that
// was passed to it, not some module-level shared state.
//
// This test acts as a regression guard: if someone moves
// skillExecutionScopeStack to module scope, this test will still pass
// (because buildSessionAgentSnapshot takes it as an argument), but the
// pattern it guards against can be caught by E2E / session recovery
// tests. The framing is intentional — see advisor note.

describe("M2-U1 — concurrent snapshot calls are stack-isolated", () => {
  it("two concurrent buildSessionAgentSnapshot calls carry independent stacks", () => {
    const historyA: AgentMessage[] = [{ role: "user", content: "task A" }];
    const historyB: AgentMessage[] = [{ role: "user", content: "task B" }];

    const stackA: SessionAgentState["skillExecutionScopeStack"] = [
      { skillId: "skill_x", allowedTools: ["click"] },
    ];
    const stackB: SessionAgentState["skillExecutionScopeStack"] = [];

    const snapA = buildSessionAgentSnapshot(historyA, 5, stackA);
    const snapB = buildSessionAgentSnapshot(historyB, 2, stackB);

    // A has a scope entry; B is empty. They must not share state.
    expect(snapA.skillExecutionScopeStack).toHaveLength(1);
    expect(snapA.skillExecutionScopeStack[0]!.skillId).toBe("skill_x");
    expect(snapB.skillExecutionScopeStack).toHaveLength(0);

    // Mutating B's (empty) stack must not affect A.
    snapB.skillExecutionScopeStack.push({ skillId: "injected", allowedTools: null });
    expect(snapA.skillExecutionScopeStack).toHaveLength(1);
  });

  it("resume path — stack from snapshot can be fed back via ctx.resumedSkillScopeStack contract", () => {
    // Simulate what handleResumeRequest does: read snapshot, pass its
    // skillExecutionScopeStack as resumedSkillScopeStack to runAgentLoop.
    // We can't call runAgentLoop here, but we verify the round-trip data
    // shape is preserved end-to-end.
    const originalStack: SessionAgentState["skillExecutionScopeStack"] = [
      { skillId: "my_skill", allowedTools: ["click", "type"] },
    ];
    const snapshot = buildSessionAgentSnapshot(
      [{ role: "user", content: "task" }],
      7,
      originalStack,
    );

    // Simulate the resume call: snapshot.skillExecutionScopeStack is what
    // handleResumeRequest passes as ctx.resumedSkillScopeStack. It should
    // carry the full stack.
    const resumedStack = snapshot.skillExecutionScopeStack;
    expect(resumedStack).toEqual(originalStack);
    expect(resumedStack[0]!.allowedTools).toEqual(["click", "type"]);
  });
});
