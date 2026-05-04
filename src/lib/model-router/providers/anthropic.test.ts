import { describe, it, expect } from "vitest";
import { _toWireMessagesForTest } from "./anthropic";
import type { AgentMessage } from "../types";

describe("anthropic toWireMessages — image", () => {
  it("ImageBlock passes through with snake_case media_type", () => {
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
    expect(wire.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
    expect(wire.messages[0].content[1]).toEqual({ type: "text", text: "what is this?" });
  });
});
