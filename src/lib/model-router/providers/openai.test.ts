import { describe, it, expect } from "vitest";
import { _toWireMessagesForTest } from "./openai";
import { getProviderMeta } from "./registry";
import type { AgentMessage } from "../types";

describe("openai toWireMessages — image", () => {
  it("user message with [image, text] becomes single wire msg with content array", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", mediaType: "image/jpeg", data: "AAAA" },
          },
          { type: "text", text: "what is this?" },
        ],
      },
    ];
    const wire = _toWireMessagesForTest(msgs);
    expect(wire).toHaveLength(1);
    expect(wire[0].role).toBe("user");
    const content = wire[0].content as Array<{ type: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,AAAA" },
    });
    expect(content[1]).toEqual({ type: "text", text: "what is this?" });
  });

  it("user message with [tool_result, text] still splits into tool + user msgs (unchanged behavior)", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "tu1", content: "result text" },
          { type: "text", text: "follow-up text" },
        ],
      },
    ];
    const wire = _toWireMessagesForTest(msgs);
    expect(wire).toHaveLength(2);
    expect(wire[0].role).toBe("tool");
    expect(wire[0].tool_call_id).toBe("tu1");
    expect(wire[0].content).toBe("result text");
    expect(wire[1].role).toBe("user");
    expect(wire[1].content).toBe("follow-up text");
  });
});

describe("openai supportsVision wiring", () => {
  it("OpenRouter inherits openai-compatible dispatch", () => {
    const meta = getProviderMeta("openrouter");
    expect(meta?.type).toBe("openai-compatible");
    expect(meta?.supportsVision).toBe(true);
  });
});
