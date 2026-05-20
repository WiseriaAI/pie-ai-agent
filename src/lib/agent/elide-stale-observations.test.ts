import { describe, expect, it } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import {
  elideStaleObservations,
  STALE_OBSERVATION_MARKER,
} from "./elide-stale-observations";

// An observation text mirrors buildObservationMessage's shape: a cheap
// header, a blank line, then one or more <untrusted_page_content> frames.
function obs(url: string, elementCount: number): string {
  const frames = Array.from({ length: elementCount }, (_, i) => `[${i}] button "btn ${i}"`).join("\n");
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "Semantic:",
    "  Headings:",
    "    H1: Hello",
    "",
    `<untrusted_page_content frame_id="0" frame_url="${url}">`,
    "Elements:",
    frames,
    "</untrusted_page_content>",
  ].join("\n");
}

// Like obs, but with TWO <untrusted_page_content> frame blocks.
function obs2(url: string, elementCount: number): string {
  const frame = (fid: number) =>
    [
      `<untrusted_page_content frame_id="${fid}" frame_url="${url}">`,
      "Elements:",
      Array.from({ length: elementCount }, (_, i) => `[${i}] button "btn ${i}"`).join("\n"),
      "</untrusted_page_content>",
    ].join("\n");
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "Semantic:",
    "  Headings:",
    "    H1: Hello",
    "",
    frame(0),
    frame(1),
  ].join("\n");
}

function userTask(task: string, observation: string): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: task },
      { type: "text", text: observation },
    ] as ContentBlock[],
  };
}

function assistantToolUse(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "click", input: { elementIndex: 1 } }] as ContentBlock[],
  };
}

function userToolResult(id: string, observation: string): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "tool_result", toolUseId: id, content: "clicked" },
      { type: "text", text: observation },
    ] as ContentBlock[],
  };
}

describe("elideStaleObservations", () => {
  it("keeps the most recent observation full, elides earlier ones", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("do the thing", obs("https://a", 50)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 50)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 50)),
    ];
    const out = elideStaleObservations(history);

    // newest observation (https://c) is untouched
    const newest = out[5].content as ContentBlock[];
    expect((newest[1] as { text: string }).text).toContain("<untrusted_page_content");
    expect((newest[1] as { text: string }).text).not.toContain(STALE_OBSERVATION_MARKER);

    // earlier react observation (https://b) is elided
    const mid = out[3].content as ContentBlock[];
    const midObs = (mid[1] as { text: string }).text;
    expect(midObs).toContain("Current URL: https://b");      // header kept
    expect(midObs).toContain("Semantic:");                   // header kept
    expect(midObs).toContain(STALE_OBSERVATION_MARKER);      // frames replaced
    expect(midObs).not.toContain("<untrusted_page_content"); // frames gone

    // head user(task) observation (https://a) is elided but task text kept
    const head = out[1].content as ContentBlock[];
    expect((head[0] as { text: string }).text).toBe("do the thing");
    const headObs = (head[1] as { text: string }).text;
    expect(headObs).toContain("Current URL: https://a");
    expect(headObs).toContain(STALE_OBSERVATION_MARKER);
    expect(headObs).not.toContain("<untrusted_page_content");
  });

  it("does not mutate the input array or its message objects", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const snapshot = JSON.parse(JSON.stringify(history));
    elideStaleObservations(history);
    expect(history).toEqual(snapshot);
  });

  it("preserves tool_result blocks unchanged when eliding", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 10)),
    ];
    const out = elideStaleObservations(history);
    const mid = out[3].content as ContentBlock[];
    expect(mid[0]).toEqual({ type: "tool_result", toolUseId: "t1", content: "clicked" });
  });

  it("returns history with a single observation unchanged", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
    ];
    const out = elideStaleObservations(history);
    expect((out[1].content as ContentBlock[])[1]).toEqual(
      (history[1].content as ContentBlock[])[1],
    );
  });

  it("leaves a text block without frame markers untouched", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "plain task no frames" }] as ContentBlock[] },
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const out = elideStaleObservations(history);
    expect((out[1].content as ContentBlock[])[0]).toEqual({
      type: "text",
      text: "plain task no frames",
    });
  });

  // m1: only the LAST text block is ever elided. If the last text block has
  // no frame marker but an earlier text block IS an observation, the earlier
  // observation is left FULL (documents the "observation = last text block"
  // contract).
  it("only elides the last text block, leaving earlier observation blocks full", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: obs("https://a", 10) },
          { type: "text", text: "trailing note without frames" },
        ] as ContentBlock[],
      },
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const out = elideStaleObservations(history);
    const head = out[1].content as ContentBlock[];
    // earlier (observation) block left FULL
    expect((head[0] as { text: string }).text).toContain("<untrusted_page_content");
    expect((head[0] as { text: string }).text).not.toContain(STALE_OBSERVATION_MARKER);
    // last text block (no frames) untouched
    expect((head[1] as { text: string }).text).toBe("trailing note without frames");
  });

  // m3: a multi-frame observation on a stale turn loses ALL frames (split at
  // first <untrusted_page_content occurrence drops everything after it).
  it("elides all frames from a multi-frame stale observation", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs2("https://a", 5)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 5)),
    ];
    const out = elideStaleObservations(history);
    const head = out[1].content as ContentBlock[];
    const headObs = (head[1] as { text: string }).text;
    expect(headObs).toContain("Current URL: https://a");   // header kept
    expect(headObs).toContain("Semantic:");                // header kept
    expect(headObs).toContain(STALE_OBSERVATION_MARKER);   // marker present
    expect(headObs).not.toContain("<untrusted_page_content"); // ALL frames gone
  });

  // m4: idempotency — running twice == running once (marker text has no
  // frame marker, so a second pass is a no-op).
  it("is idempotent", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("do the thing", obs("https://a", 20)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 20)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 20)),
    ];
    const once = elideStaleObservations(history);
    const twice = elideStaleObservations(once);
    expect(twice).toEqual(once);
  });

  // m2: a string-content user turn that is NOT the last user turn is returned
  // unchanged (verifies the typeof === "string" guard).
  it("leaves a non-last string-content user turn unchanged", () => {
    const stringTurn: AgentMessage = { role: "user", content: "plain string task" };
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      stringTurn,
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const out = elideStaleObservations(history);
    expect(out[1]).toEqual({ role: "user", content: "plain string task" });
  });
});
