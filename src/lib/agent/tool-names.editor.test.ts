import { describe, expect, it } from "vitest";
import { getToolClass, KNOWN_EDITOR_TOOL_NAMES } from "./tool-names";

describe("editor tool classes", () => {
  it("read_editor is read-class, set_editor_value is write-class", () => {
    expect(getToolClass("read_editor")).toBe("read");
    expect(getToolClass("set_editor_value")).toBe("write");
  });

  it("exports the editor tool name list", () => {
    expect([...KNOWN_EDITOR_TOOL_NAMES]).toEqual(["read_editor", "set_editor_value"]);
  });
});
