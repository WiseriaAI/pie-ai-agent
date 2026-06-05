import { describe, expect, it } from "vitest";
import { getEditorTools } from "./tools";

describe("getEditorTools wiring", () => {
  it("returns read_editor and set_editor_value", () => {
    const tools = getEditorTools({
      acquireSession: async () => ({}) as never,
      requestConsent: async () => true,
      sessionId: "s1",
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["read_editor", "set_editor_value"]);
  });
});
