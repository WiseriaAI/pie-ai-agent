import { describe, expect, it } from "vitest";
import { parseTextToolInvocations } from "./text-tool-invocation";

describe("parseTextToolInvocations", () => {
  it("parses a leaked anthropic-compatible tool_invocation tag", () => {
    expect(
      parseTextToolInvocations(
        '<tool_invocation name="read_page" arguments={"tabId": 736359264, "mode": "content"} />',
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^text_tool_/),
        name: "read_page",
        args: { tabId: 736359264, mode: "content" },
      },
    ]);
  });

  it("does not parse normal prose that happens to mention a tool_invocation tag", () => {
    expect(
      parseTextToolInvocations(
        'I would call <tool_invocation name="read_page" arguments={"tabId": 1} /> next.',
      ),
    ).toEqual([]);
  });

  it("does not parse invalid JSON arguments", () => {
    expect(
      parseTextToolInvocations(
        '<tool_invocation name="read_page" arguments={tabId: 1} />',
      ),
    ).toEqual([]);
  });

  it("does not parse text containing multiple tags", () => {
    expect(
      parseTextToolInvocations(
        '<tool_invocation name="read_page" arguments={"tabId": 1} /><tool_invocation name="done" arguments={} />',
      ),
    ).toEqual([]);
  });
});
