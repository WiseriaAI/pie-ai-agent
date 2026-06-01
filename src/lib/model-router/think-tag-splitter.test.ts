import { describe, it, expect } from "vitest";
import { createThinkTagSplitter, type ThinkSegment } from "./think-tag-splitter";

function run(chunks: string[]): ThinkSegment[] {
  const s = createThinkTagSplitter();
  const out: ThinkSegment[] = [];
  for (const c of chunks) out.push(...s.feed(c));
  out.push(...s.flush());
  // 合并相邻同类，便于断言
  const merged: ThinkSegment[] = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (last && last.kind === seg.kind) last.text += seg.text;
    else merged.push({ ...seg });
  }
  return merged.filter((m) => m.text.length > 0);
}

describe("createThinkTagSplitter", () => {
  it("passes plain text through untouched", () => {
    expect(run(["hello world"])).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("splits a complete <think>…</think> in one chunk", () => {
    expect(run(["before<think>reason</think>after"])).toEqual([
      { kind: "text", text: "before" },
      { kind: "think", text: "reason" },
      { kind: "text", text: "after" },
    ]);
  });

  it("handles a tag split across chunk boundary (<th|ink>)", () => {
    expect(run(["a<th", "ink>b</think>c"])).toEqual([
      { kind: "text", text: "a" },
      { kind: "think", text: "b" },
      { kind: "text", text: "c" },
    ]);
  });

  it("handles a closing tag split across boundary (</thi|nk>)", () => {
    expect(run(["<think>x</thi", "nk>y"])).toEqual([
      { kind: "think", text: "x" },
      { kind: "text", text: "y" },
    ]);
  });

  it("treats a non-tag '<' as text", () => {
    expect(run(["a < b > c"])).toEqual([{ kind: "text", text: "a < b > c" }]);
  });

  it("emits an unclosed <think> tail as think on flush", () => {
    expect(run(["<think>still thinking"])).toEqual([
      { kind: "think", text: "still thinking" },
    ]);
  });

  it("emits a dangling partial tag at EOF as text", () => {
    expect(run(["hello<thi"])).toEqual([{ kind: "text", text: "hello<thi" }]);
  });
});
