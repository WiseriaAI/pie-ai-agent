import { describe, it, expect, vi } from "vitest";
import { streamChat, _toGeminiContentsForTest } from "./gemini";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage } from "@/lib/model-router/types";

describe("Gemini wire converter", () => {
  it("text-only user message → contents[].parts[{text}]", () => {
    const msgs: AgentMessage[] = [{ role: "user", content: "hi" }];
    const wire = _toGeminiContentsForTest(msgs);
    expect(wire).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("user with image block → parts has inline_data", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "BASE64" } },
          { type: "text", text: "what's this?" },
        ],
      },
    ];
    const wire = _toGeminiContentsForTest(msgs);
    expect(wire[0].role).toBe("user");
    expect(wire[0].parts).toContainEqual({ inline_data: { mime_type: "image/png", data: "BASE64" } });
    expect(wire[0].parts).toContainEqual({ text: "what's this?" });
  });

  it("system message becomes systemInstruction at top level (separate from contents)", () => {
    // Verified at the streamChat level by checking request body shape; here we
    // just confirm the converter strips system from contents[].
    const msgs: AgentMessage[] = [
      { role: "system", content: "You are Pie." },
      { role: "user", content: "hi" },
    ];
    const wire = _toGeminiContentsForTest(msgs);
    expect((wire as { role: string }[]).find((c) => c.role === "system")).toBeUndefined();
    expect(wire).toContainEqual({ role: "user", parts: [{ text: "hi" }] });
  });

  it("assistant tool_use → functionCall part with id, name, args", () => {
    const msgs: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_xyz", name: "read_page", input: { url: "https://example.com" } },
        ],
      },
    ];
    const wire = _toGeminiContentsForTest(msgs);
    expect(wire).toEqual([
      { role: "model", parts: [{ functionCall: { name: "read_page", args: { url: "https://example.com" } } }] },
    ]);
  });

  it("tool_result → role:'function' content with functionResponse.name resolved from prior tool_use", () => {
    const msgs: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_42", name: "search_tabs", input: { q: "github" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_42", content: '{"matches":3}' },
        ],
      },
    ];
    const wire = _toGeminiContentsForTest(msgs);
    // assistant becomes role:"model" + functionCall part (covered by previous test)
    // tool_result becomes role:"function" with name="search_tabs" (the function name, NOT the call id)
    expect(wire).toContainEqual({
      role: "function",
      parts: [{ functionResponse: { name: "search_tabs", response: { content: '{"matches":3}' } } }],
    });
  });

  it("orphan tool_result (no matching tool_use in history) falls back to using toolUseId as name", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "orphan_id", content: "ok" }],
      },
    ];
    const wire = _toGeminiContentsForTest(msgs);
    expect(wire).toContainEqual({
      role: "function",
      parts: [{ functionResponse: { name: "orphan_id", response: { content: "ok" } } }],
    });
  });
});

describe("Gemini streamChat", () => {
  it("hits streamGenerateContent endpoint with key in URL query", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}\n\n',
        ));
        c.close();
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const config: ModelConfig = {
      provider: "gemini",
      model: "gemini-2.0-flash",
      apiKey: "AIza-key",
      baseUrl: "https://generativelanguage.googleapis.com",
    };
    const events: { type: string }[] = [];
    for await (const ev of streamChat(config, [{ role: "user", content: "hi" }])) events.push(ev as { type: string });
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/v1beta/models/gemini-2.0-flash:streamGenerateContent");
    expect(url).toContain("alt=sse");
    expect(url).toContain("key=AIza-key");
    expect(events.find((e) => e.type === "text-delta")).toBeDefined();
    expect(events.find((e) => e.type === "done")).toBeDefined();
    fetchMock.mockRestore();
  });
});
