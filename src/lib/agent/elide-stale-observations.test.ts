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

// ---------------------------------------------------------------------------
// Pull-mode (Phase 3): read_page snapshots ride tool_result blocks. These are
// the heavy carriers on page-operation tasks and the whole reason the react
// segment used to grow unboundedly.
// ---------------------------------------------------------------------------

/** Mirrors read-page.ts observation shape (interactive mode): cheap header,
 *  frame_map, then the bulky interactive index + frame content blocks. */
function readPageResult(url: string, elementCount: number): string {
  const elements = Array.from(
    { length: elementCount },
    (_, i) =>
      `  <interactive_element frame_id="0" pie_idx="${i}" tag="button" role="button">btn ${i}</interactive_element>`,
  ).join("\n");
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "<frame_map>",
    `  frame_id="0" url="${url}"`,
    "</frame_map>",
    "",
    `<interactive_index mode="interactive" total="${elementCount}">`,
    elements,
    "</interactive_index>",
    "",
    `<untrusted_page_content frame_id="0" frame_url="${url}">`,
    "<div>page body</div>",
    "</untrusted_page_content>",
  ].join("\n");
}

/** Atlas mode: no interactive index; bulk starts at the first frame block. */
function readPageAtlasResult(url: string): string {
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "<frame_map>",
    `  frame_id="0" url="${url}"`,
    "</frame_map>",
    "",
    `<untrusted_page_content frame_id="0" mode="atlas">`,
    "<page_atlas>…</page_atlas>",
    "</untrusted_page_content>",
  ].join("\n");
}

function userToolResultOnly(id: string, content: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolUseId: id, content }] as ContentBlock[],
  };
}

describe("elideStaleObservations — read_page tool_result elision (pull mode)", () => {
  it("elides a stale read_page tool_result: header + frame_map kept, index and frames gone", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("do the thing", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageResult("https://b", 50)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history);

    const stale = out[3].content as ContentBlock[];
    const tr = stale[0] as Extract<ContentBlock, { type: "tool_result" }>;
    expect(tr.type).toBe("tool_result");
    expect(tr.toolUseId).toBe("t1"); // pairing preserved
    expect(tr.content).toContain("Current URL: https://b"); // header kept
    expect(tr.content).toContain("<frame_map>"); // frame_map kept
    expect(tr.content).toContain(STALE_OBSERVATION_MARKER);
    expect(tr.content).not.toContain("<interactive_index"); // bulky index gone
    expect(tr.content).not.toContain("<untrusted_page_content"); // frame payload gone
    expect(tr.content).not.toContain("btn 0");

    // The most recent user turn keeps its full content, by reference.
    expect(out[5]).toBe(history[5]);
  });

  it("elides atlas-mode results (cut at the first frame block when no index exists)", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageAtlasResult("https://b")),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history);
    const tr = (out[3].content as ContentBlock[])[0] as Extract<ContentBlock, { type: "tool_result" }>;
    expect(tr.content).toContain("Current URL: https://b");
    expect(tr.content).toContain(STALE_OBSERVATION_MARKER);
    expect(tr.content).not.toContain("<untrusted_page_content");
    expect(tr.content).not.toContain("<page_atlas>");
  });

  it("elides every snapshot tool_result in a stale multi-result turn", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1a", content: readPageResult("https://b1", 20) },
          { type: "tool_result", toolUseId: "t1b", content: readPageAtlasResult("https://b2") },
        ] as ContentBlock[],
      },
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history);
    const stale = out[3].content as ContentBlock[];
    for (const b of stale) {
      const tr = b as Extract<ContentBlock, { type: "tool_result" }>;
      expect(tr.content).toContain(STALE_OBSERVATION_MARKER);
      expect(tr.content).not.toContain("<untrusted_page_content");
    }
    expect((stale[0] as { toolUseId: string }).toolUseId).toBe("t1a");
    expect((stale[1] as { toolUseId: string }).toolUseId).toBe("t1b");
  });

  it("leaves non-snapshot tool results (read_struct / click / …) untouched", () => {
    const structResult = "<untrusted_struct_records>[{\"price\": 42}]</untrusted_struct_records>";
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", structResult),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history);
    // Nothing elidable in the middle turn → same message object returned.
    expect(out[3]).toBe(history[3]);
  });

  it("produces a bare marker when the payload starts directly with the frame block", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", "<untrusted_page_content>fares…</untrusted_page_content>"),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history);
    const tr = (out[3].content as ContentBlock[])[0] as Extract<ContentBlock, { type: "tool_result" }>;
    expect(tr.content).toBe(STALE_OBSERVATION_MARKER);
  });

  it("keeps the most recent user turn's snapshot tool_result full", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageResult("https://b", 30)),
    ];
    const out = elideStaleObservations(history);
    expect(out[3]).toBe(history[3]);
  });

  it("is idempotent across the tool_result path", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageResult("https://b", 30)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const once = elideStaleObservations(history);
    const twice = elideStaleObservations(once);
    expect(twice).toEqual(once);
  });

  // Cache-stability invariant: a block elided at step N must stay
  // byte-identical at step N+1 (only the previous last user turn flips
  // full → marker). Simulated by appending one more react pair.
  it("is monotone: elided stale turns stay byte-identical as history grows", () => {
    const base: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageResult("https://b", 30)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const stepN = elideStaleObservations(base);
    const grown: AgentMessage[] = [
      ...base,
      assistantToolUse("t3"),
      userToolResult("t3", obs("https://d", 5)),
    ];
    const stepN1 = elideStaleObservations(grown);
    // Every message before the previous last user turn is byte-identical.
    for (let i = 0; i < base.length - 1; i++) {
      expect(stepN1[i]).toEqual(stepN[i]);
    }
    // The previous last user turn has now flipped to elided.
    const flipped = stepN1[base.length - 1].content as ContentBlock[];
    const flippedObs = (flipped[1] as { text: string }).text;
    expect(flippedObs).toContain(STALE_OBSERVATION_MARKER);
    expect(flippedObs).not.toContain("<untrusted_page_content");
  });
});
