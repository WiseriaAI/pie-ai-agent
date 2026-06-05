import { describe, expect, it } from "vitest";
import { isCdpGatedToolName, CDP_GATED_TOOL_NAMES } from "./tool-names";

describe("isCdpGatedToolName", () => {
  it("returns true for CDP-only tools (mouse / keyboard / editor)", () => {
    for (const name of ["click", "hover", "dispatch_keyboard_input", "press_key", "read_editor", "set_editor_value"]) {
      expect(isCdpGatedToolName(name)).toBe(true);
    }
  });

  it("returns false for non-CDP tools (still available when CDP off)", () => {
    for (const name of ["type", "select", "scroll", "read_page", "search_page", "done", "fail"]) {
      expect(isCdpGatedToolName(name)).toBe(false);
    }
  });

  it("CDP_GATED_TOOL_NAMES is exactly the mouse+keyboard+editor set", () => {
    expect([...CDP_GATED_TOOL_NAMES].sort()).toEqual(
      ["click", "dispatch_keyboard_input", "hover", "press_key", "read_editor", "set_editor_value"].sort(),
    );
  });
});
