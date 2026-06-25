import { describe, expect, it } from "vitest";
import {
  KNOWN_BUILT_IN_TOOL_NAMES,
  KNOWN_KEYBOARD_TOOL_NAMES,
  KNOWN_EDITOR_TOOL_NAMES,
  TOOL_GROUPS,
  getToolGroup,
} from "./tool-names";

describe("TOOL_GROUPS — every known tool is grouped", () => {
  it("every built-in / keyboard / editor tool name has a group entry", () => {
    for (const name of [
      ...KNOWN_BUILT_IN_TOOL_NAMES,
      ...KNOWN_KEYBOARD_TOOL_NAMES,
      ...KNOWN_EDITOR_TOOL_NAMES,
    ]) {
      expect(TOOL_GROUPS[name], `tool "${name}" must be grouped`).toBeDefined();
    }
  });

  it("load_tools is core", () => {
    expect(TOOL_GROUPS["load_tools"]).toBe("core");
  });

  it("getToolGroup defaults unknown names to core", () => {
    expect(getToolGroup("totally_unknown_tool")).toBe("core");
  });

  it("known long-tail tools land in the right groups", () => {
    expect(getToolGroup("read_pdf")).toBe("pdf");
    expect(getToolGroup("save_scratchpad")).toBe("scratchpad");
    expect(getToolGroup("create_schedule")).toBe("schedule");
    expect(getToolGroup("create_skill")).toBe("skill-authoring");
    expect(getToolGroup("use_skill")).toBe("skill-mediation");
    expect(getToolGroup("capture_visible_tab")).toBe("screenshot");
    expect(getToolGroup("read_local_file")).toBe("local-file");
    expect(getToolGroup("close_tabs")).toBe("core");
    expect(getToolGroup("press_key")).toBe("core");
    expect(getToolGroup("set_editor_value")).toBe("core");
    expect(getToolGroup("output_file")).toBe("core");
  });
});
