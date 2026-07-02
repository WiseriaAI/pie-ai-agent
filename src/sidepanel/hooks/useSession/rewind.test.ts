import { describe, it, expect } from "vitest";
import type { DisplayMessage } from "@/types";
import { buildRewindInput, buildRewindAgentTombstone } from "./rewind";

type UserMsg = Extract<DisplayMessage, { role: "user" }>;

const baseUser = (over: Partial<UserMsg> = {}): UserMsg => ({
  role: "user",
  content: "hello",
  ...over,
});

describe("buildRewindInput — edit mode", () => {
  it("uses the edited text as content", () => {
    const out = buildRewindInput(baseUser({ content: "original" }), "changed");
    expect(out.content).toBe("changed");
  });

  it("drops the stale slash expansion when editing", () => {
    const msg = baseUser({ content: "/foo", expandedForLLM: "expanded foo" });
    const out = buildRewindInput(msg, "plain text now");
    expect(out.expandedForLLM).toBeUndefined();
    expect(out.content).toBe("plain text now");
  });

  it("carries structured quotes and fileAttachments through an edit", () => {
    const quotes: UserMsg["quotes"] = [
      { id: "q1", kind: "text", text: "cite", sourceUrl: "https://x", sourceTabId: 1 },
    ];
    const fileAttachments: UserMsg["fileAttachments"] = [
      {
        kind: "file",
        id: "f1",
        name: "a.txt",
        mime: "text/plain",
        text: "abc",
        truncated: false,
        totalChars: 3,
        source: "picker",
      },
    ];
    const out = buildRewindInput(baseUser({ quotes, fileAttachments }), "edited");
    expect(out.quotes).toBe(quotes);
    expect(out.fileAttachments).toBe(fileAttachments);
  });

  it("never carries image attachments (bytes are not persisted)", () => {
    const msg = baseUser({
      attachments: [
        {
          id: "img1",
          kind: "image",
          mediaType: "image/png",
          data: "x",
          width: 1,
          height: 1,
          byteLength: 1,
        },
      ],
    });
    const out = buildRewindInput(msg, "edited");
    expect("attachments" in out).toBe(false);
  });
});

describe("buildRewindInput — resend as-is", () => {
  it("replays the original content verbatim", () => {
    const out = buildRewindInput(baseUser({ content: "keep me" }));
    expect(out.content).toBe("keep me");
  });

  it("replays the slash expansion so a slash turn re-expands identically", () => {
    const msg = baseUser({ content: "/foo", expandedForLLM: "expanded foo" });
    const out = buildRewindInput(msg);
    expect(out.expandedForLLM).toBe("expanded foo");
  });

  it("omits expandedForLLM when the original had none", () => {
    const out = buildRewindInput(baseUser({ content: "plain" }));
    expect("expandedForLLM" in out).toBe(false);
  });

  it("omits empty quotes / fileAttachments arrays", () => {
    const out = buildRewindInput(baseUser({ quotes: [], fileAttachments: [] }));
    expect("quotes" in out).toBe(false);
    expect("fileAttachments" in out).toBe(false);
  });
});

describe("buildRewindAgentTombstone", () => {
  it("is an empty, no-in-flight-task tombstone", () => {
    const t = buildRewindAgentTombstone();
    expect(t.agentMessages).toEqual([]);
    expect(t.pendingInstructions).toEqual([]);
    expect(t.stepIndex).toBe(0);
    expect(t.hasImageContent).toBe(false);
  });

  it("carries no lastTaskSynth (so the synth-bridge is a no-op after rewind)", () => {
    expect(buildRewindAgentTombstone().lastTaskSynth).toBeUndefined();
  });
});
