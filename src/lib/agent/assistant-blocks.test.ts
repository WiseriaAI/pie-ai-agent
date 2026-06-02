import { describe, it, expect } from "vitest";
import { assembleAssistantBlocks } from "./assistant-blocks";

describe("assembleAssistantBlocks", () => {
  it("prepends thinking blocks before text and tool_use", () => {
    const blocks = assembleAssistantBlocks(
      [{ type: "thinking", thinking: "why", signature: "S" }],
      "hello",
      [{ id: "t1", name: "click", args: { x: 1 } }],
    );
    expect(blocks).toEqual([
      { type: "thinking", thinking: "why", signature: "S" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "click", input: { x: 1 } },
    ]);
  });

  it("omits the text block when text is empty", () => {
    const blocks = assembleAssistantBlocks([], "", [{ id: "t1", name: "x", args: {} }]);
    expect(blocks).toEqual([{ type: "tool_use", id: "t1", name: "x", input: {} }]);
  });

  it("supports thinking-only (no text, no tools)", () => {
    expect(assembleAssistantBlocks([{ type: "thinking", thinking: "t" }], "", [])).toEqual([
      { type: "thinking", thinking: "t" },
    ]);
  });
});
