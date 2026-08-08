import { describe, expect, it } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import { findReactStartIdx } from "./window";

// applySlidingWindow 的测试随该函数一并删除（见 window.ts 顶部注释）：按对数砍
// react 段在大窗口模型上纯粹是自伤，且砍的正是自动 prefix caching 唯一依赖的
// 稳定前缀。上下文现在完全由 compaction / token budget / elision 按真实 token 控制。

describe("findReactStartIdx", () => {
  it("returns -1 when no assistant ContentBlock[] message exists", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      { role: "assistant", content: "plain text reply" },
    ];
    expect(findReactStartIdx(messages)).toBe(-1);
  });

  it("returns 0 when the first message is an assistant ContentBlock[] turn", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", id: "tu1", name: "click", input: {} },
    ];
    const messages: AgentMessage[] = [
      { role: "assistant", content: blocks },
      { role: "user", content: "result" },
    ];
    expect(findReactStartIdx(messages)).toBe(0);
  });

  it("returns the correct mid-array index", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", id: "tu2", name: "scroll", input: {} },
    ];
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      { role: "assistant", content: blocks }, // index 2
      { role: "user", content: "obs" },
    ];
    expect(findReactStartIdx(messages)).toBe(2);
  });
});
