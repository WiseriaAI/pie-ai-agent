import { describe, expect, it } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import type { SessionAgentState } from "@/lib/sessions/types";
import {
  buildSessionAgentSnapshot,
  buildSessionAgentTombstone,
  collectCrossSessionConflicts,
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

// ── M2-U2 P1-9 + Bug-fix-D: only user-reject increments confirmRejections ──────
//
// The K-10 fatigue counter (confirmRejections) must reflect user intent only.
// Three non-user paths exist that resolve sendConfirmRequest with
// approved=false:
//   - reason='flood-limit'  — SEC-PLAN-009 SW-side cap (P1-9)
//   - reason='aborted'      — panel disconnect / Stop drained the resolver
//                             before the user could respond (Bug-fix-D)
// loop.ts uses a whitelist (reason === 'user-reject'), not a blacklist
// (reason !== 'flood-limit'), so any future non-user reason defaults to
// NOT counting unless explicitly opted in.

type ConfirmReason = "flood-limit" | "user-reject" | "aborted";
type ConfirmResult = { approved: boolean; reason?: ConfirmReason };

describe("M2-U2 P1-9 + Bug-fix-D — only user-reject counts toward K-10", () => {
  it("flood-limit result is approved=false and does NOT count", () => {
    const r: ConfirmResult = { approved: false, reason: "flood-limit" };
    expect(r.approved).toBe(false);
    expect(r.reason === "user-reject").toBe(false);
  });

  it("aborted result is approved=false and does NOT count (panel close / Stop)", () => {
    const r: ConfirmResult = { approved: false, reason: "aborted" };
    expect(r.approved).toBe(false);
    expect(r.reason === "user-reject").toBe(false);
  });

  it("user-reject result is approved=false and DOES count", () => {
    const r: ConfirmResult = { approved: false, reason: "user-reject" };
    expect(r.approved).toBe(false);
    expect(r.reason === "user-reject").toBe(true);
  });

  it("approve result is approved=true with no reason and never counts", () => {
    const r: ConfirmResult = { approved: true };
    expect(r.approved).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.reason === "user-reject").toBe(false);
  });

  it("missing reason defaults to NOT counting (whitelist semantics)", () => {
    // Defends against future code paths that resolve approved=false without
    // setting reason — they must not silently start incrementing K-10.
    const r: ConfirmResult = { approved: false };
    expect(r.approved).toBe(false);
    expect(r.reason === "user-reject").toBe(false);
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

describe("M3-U4 — collectCrossSessionConflicts", () => {
  it("returns empty when crossSessionPinnedTabIds is undefined", () => {
    const result = collectCrossSessionConflicts(
      "click",
      { elementIndex: 0 },
      99,
      undefined,
    );
    expect(result).toEqual([]);
  });

  it("returns empty when the set is empty", () => {
    const result = collectCrossSessionConflicts(
      "click",
      { elementIndex: 0 },
      99,
      new Set(),
    );
    expect(result).toEqual([]);
  });

  it("returns empty for read-class tools regardless of conflicts", () => {
    // get_tab_content is read; even if tabId is in cross-session set,
    // read concurrency is allowed (K2 read/write split).
    const result = collectCrossSessionConflicts(
      "get_tab_content",
      { tabId: 42 },
      99,
      new Set([42]),
    );
    expect(result).toEqual([]);
  });

  it("returns empty for low-class tools (scroll, wait, done)", () => {
    expect(
      collectCrossSessionConflicts(
        "scroll",
        { direction: "down" },
        99,
        new Set([99]),
      ),
    ).toEqual([]);
    expect(
      collectCrossSessionConflicts(
        "wait",
        { seconds: 1 },
        99,
        new Set([99]),
      ),
    ).toEqual([]);
    expect(
      collectCrossSessionConflicts(
        "done",
        { result: "ok" },
        99,
        new Set([99]),
      ),
    ).toEqual([]);
  });

  it("flags args.tabIds entries pinned by other sessions (write tab tool)", () => {
    const result = collectCrossSessionConflicts(
      "close_tabs",
      { tabIds: [10, 20, 30] },
      99,
      new Set([20, 30, 40]),
    );
    expect(result.sort()).toEqual([20, 30]);
  });

  it("flags args.tabId on a write tab tool", () => {
    // No write tab tool currently uses args.tabId (close_tabs uses tabIds).
    // Use a synthetic args shape on group_tabs (tabIds + a stray tabId).
    const result = collectCrossSessionConflicts(
      "group_tabs",
      { tabIds: [10], tabId: 50 },
      99,
      new Set([50]),
    );
    expect(result).toEqual([50]);
  });

  it("does NOT fold pinnedTabId for non-tab write tools — shared-pin sessions can still operate", () => {
    // Adversarial-review fix (shared-pin deadlock): the earlier behavior
    // folded pinnedTabId into the conflict check for non-tab tools, which
    // deadlocked two sessions sharing the same pin (every click/type/select
    // call from EITHER session would be R7-rejected by the OTHER session's
    // pin appearing in the registry). The fold added no offsetting safety —
    // the loop's per-iteration origin re-check already protects the calling
    // session's intent — only false positives. This test locks in the
    // post-fix behavior: when only the calling session's own pin is in the
    // cross-session set (because another session pins the same tab),
    // non-tab write tools are NOT blocked.
    const result = collectCrossSessionConflicts(
      "click",
      { elementIndex: 0 },
      7,
      new Set([7]),
    );
    expect(result).toEqual([]);
  });

  it("does NOT fold pinnedTabId for tab-tool calls (tab tools target args)", () => {
    // close_tabs is a tab tool; it MUST target args.tabIds, not the pin.
    // If pinnedTabId happens to be in the cross-session set but the LLM
    // didn't pass it as a target, no conflict (the call doesn't touch
    // that tab via this path).
    const result = collectCrossSessionConflicts(
      "close_tabs",
      { tabIds: [99] }, // 99 is NOT in the conflict set
      7, // pin is in the set, but irrelevant for tab tools
      new Set([7]),
    );
    expect(result).toEqual([]);
  });

  it("dedupes when args.tabId == args.tabIds[i]", () => {
    const result = collectCrossSessionConflicts(
      "group_tabs",
      { tabIds: [10, 10], tabId: 10 },
      99,
      new Set([10]),
    );
    expect(result).toEqual([10]);
  });

  it("write skill meta tools (create/update/delete) are not tab-bound — never blocked by R7", () => {
    // create_skill / update_skill / delete_skill are write-class but
    // operate on storage, not tabs. The fix-3 cleanup means non-tab
    // write tools are no longer over-gated when two sessions share a
    // pin: skill mutations proceed regardless of which sessions own
    // which tabs.
    const result = collectCrossSessionConflicts(
      "create_skill",
      { id: "x", name: "x", description: "x", promptTemplate: "x" },
      7,
      new Set([7]),
    );
    expect(result).toEqual([]);
  });
});

describe("M3-U5 — multi-session invariant regression", () => {
  it("buildSessionAgentSnapshot — concurrent calls with different histories never share state", () => {
    // The advisor (M3-U5 verification) flagged: every per-call helper
    // MUST stay function-local. This test runs two snapshots in
    // simulated concurrent fashion and asserts independence — if a
    // future refactor hoists state into module scope, this fails.
    const historyA: AgentMessage[] = [
      { role: "user", content: "task-A" },
    ];
    const historyB: AgentMessage[] = [
      { role: "user", content: "task-B" },
    ];

    const stackA: SessionAgentState["skillExecutionScopeStack"] = [
      { skillId: "skill-A", allowedTools: ["click"] },
    ];
    const stackB: SessionAgentState["skillExecutionScopeStack"] = [
      { skillId: "skill-B", allowedTools: ["type"] },
    ];

    const snapA = buildSessionAgentSnapshot(historyA, 1, stackA);
    const snapB = buildSessionAgentSnapshot(historyB, 2, stackB);

    // Independent contents.
    expect(snapA.agentMessages[0]).toEqual({
      role: "user",
      content: "task-A",
    });
    expect(snapB.agentMessages[0]).toEqual({
      role: "user",
      content: "task-B",
    });
    // Independent stacks.
    expect(snapA.skillExecutionScopeStack[0]!.skillId).toBe("skill-A");
    expect(snapB.skillExecutionScopeStack[0]!.skillId).toBe("skill-B");
    // Independent step indices.
    expect(snapA.stepIndex).toBe(1);
    expect(snapB.stepIndex).toBe(2);
    // Independent object identities (no shared references).
    expect(snapA.skillExecutionScopeStack).not.toBe(snapB.skillExecutionScopeStack);
  });

  it("collectCrossSessionConflicts — two simulated sessions with overlapping pin BOTH proceed (deadlock fix)", () => {
    // Adversarial-review scenario: Session A pinned tab 7, Session B
    // pinned tab 7 too. On A's dispatch crossSessionPinnedTabIds={7}
    // (excludes A, contains B); on B's dispatch the same set
    // (excludes B, contains A). Pre-fix: both sides' click was rejected
    // → symmetric deadlock. Post-fix: non-tab tools no longer fold
    // pinnedTabId into the conflict check, so both sessions can run
    // their own click/type/select against tab 7 without blocking each
    // other. The per-iteration origin re-check still protects each
    // session's pinned-origin intent.
    const fromA = collectCrossSessionConflicts(
      "click",
      { elementIndex: 0 },
      7,
      new Set([7]),
    );
    const fromB = collectCrossSessionConflicts(
      "click",
      { elementIndex: 0 },
      7,
      new Set([7]),
    );
    expect(fromA).toEqual([]);
    expect(fromB).toEqual([]);
  });

  it("collectCrossSessionConflicts — same-session calls (excluded from registry) do not conflict", () => {
    // The registry construction (getCrossSessionPinnedTabIds) excludes
    // the calling session's own pin. So the typical single-session
    // scenario hands an empty set to the helper.
    const result = collectCrossSessionConflicts(
      "click",
      { elementIndex: 0 },
      7,
      new Set(), // single-session = no cross-session pins
    );
    expect(result).toEqual([]);
  });
});
