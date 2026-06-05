import { describe, it, expect } from "vitest";
import "@/test/setup";
import { chromeMock } from "@/test/setup";
import { planAbortResumeSeed } from "@/lib/agent/abort-resume";
import { buildDoneSnapshot } from "@/lib/agent/loop";
import type { SessionAgentState } from "@/lib/sessions/types";

const SID = "abort-resume-xlayer";

describe("abort-resume cross-layer", () => {
  it("abort (non-image) → buildDoneSnapshot null → stored history survives → planAbortResumeSeed resumes", () => {
    const history = [
      { role: "system", content: "s" },
      { role: "user", content: "<untrusted_user_message>X</untrusted_user_message>" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    // simulate the last per-step snapshot already persisted to storage
    chromeMock.storage.local.__store[`session_${SID}_agent`] = {
      agentMessages: history,
      pendingInstructions: [],
      stepIndex: 2,
      hasImageContent: false,
    } as SessionAgentState;

    // emitDone(abort, non-image) would compute this and SKIP the write:
    expect(buildDoneSnapshot("abort", false, null, undefined)).toBeNull();

    // storage therefore still holds the history
    const saved = chromeMock.storage.local.__store[`session_${SID}_agent`] as SessionAgentState;
    expect(saved.agentMessages.length).toBe(4);
    expect(saved.stepIndex).toBe(2);

    // next chat-start resumes it
    const resume = planAbortResumeSeed(saved, [{ role: "user", content: "continue please" }]);
    expect(resume).not.toBeNull();
    expect(resume!.resumedFromStep).toBe(2);
    expect(resume!.resumedAgentMessages.length).toBe(5);
  });
});
