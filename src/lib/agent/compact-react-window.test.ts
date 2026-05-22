import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import { compactReactWindow, type ReactSummarizer } from "./compact-react-window";

function toolUsePair(name: string, big: string): AgentMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id: name, name, input: { data: big } } as ContentBlock] },
    { role: "user", content: [{ type: "tool_result", toolUseId: name, content: big } as ContentBlock] },
  ];
}
function baseHistory(pairs: number, bigLen = 100): AgentMessage[] {
  const h: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
  ];
  for (let i = 0; i < pairs; i++) h.push(...toolUsePair(`t${i}`, "y".repeat(bigLen)));
  return h;
}
const okSummarizer: ReactSummarizer = vi.fn(async () => "動作: t0 → t1\n発見: 関键数据 42");
const abortSignal = () => new AbortController().signal;

describe("compactReactWindow — fast path", () => {
  it("不超阈值时 history 不变", async () => {
    const h = baseHistory(6);
    const before = structuredClone(h);
    await compactReactWindow(h, 1_000_000, okSummarizer, abortSignal());
    expect(h).toEqual(before);
  });
});
