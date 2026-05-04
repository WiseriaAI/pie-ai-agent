import { describe, it, expect } from "vitest";
import { chatMessagesToAgent, type ChatMessage } from ".";

describe("chatMessagesToAgent — attachments", () => {
  it("string-only message passes through unchanged", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "hello" }];
    expect(chatMessagesToAgent(msgs)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("user message with one image attachment → ContentBlock[] with image + text", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: "what is this?",
        attachments: [
          {
            kind: "image",
            id: "i1",
            mediaType: "image/jpeg",
            data: "AAAA",
            width: 100,
            height: 100,
            byteLength: 3,
          },
        ],
      },
    ];
    const agent = chatMessagesToAgent(msgs);
    expect(agent[0].role).toBe("user");
    expect(Array.isArray(agent[0].content)).toBe(true);
    const blocks = agent[0].content as Array<{ type: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("image");
    expect(blocks[1].type).toBe("text");
  });

  it("placeholder attachment → '[image released]' text block", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: "follow up?",
        attachments: [
          { kind: "image_placeholder", id: "i1", mediaType: "image/jpeg", width: 100, height: 100 },
        ],
      },
    ];
    const agent = chatMessagesToAgent(msgs);
    const blocks = agent[0].content as Array<{ type: string; text?: string }>;
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toMatch(/image released/i);
  });
});
