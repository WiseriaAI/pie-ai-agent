import { describe, expect, it } from "vitest";
import {
  TOOL_CLASSES,
  getToolClass,
  KNOWN_BUILT_IN_TOOL_NAMES,
  KNOWN_KEYBOARD_TOOL_NAMES,
  TAB_TOOL_NAMES,
} from "./tool-names";

describe("M3-U4 — TOOL_CLASSES registry", () => {
  it("classifies every Phase 2 DOM tool", () => {
    expect(TOOL_CLASSES.click).toBe("write");
    expect(TOOL_CLASSES.type).toBe("write");
    expect(TOOL_CLASSES.select).toBe("write");
    expect(TOOL_CLASSES.scroll).toBe("read");
    expect(TOOL_CLASSES.wait).toBe("read");
    expect(TOOL_CLASSES.done).toBe("read");
    expect(TOOL_CLASSES.fail).toBe("read");
  });

  it("classifies every Phase 2.5 keyboard tool as write", () => {
    for (const name of KNOWN_KEYBOARD_TOOL_NAMES) {
      expect(TOOL_CLASSES[name]).toBe("write");
    }
  });

  it("classifies skill meta tools (writes for create/update/delete, read for list)", () => {
    expect(TOOL_CLASSES.create_skill).toBe("write");
    expect(TOOL_CLASSES.update_skill).toBe("write");
    expect(TOOL_CLASSES.delete_skill).toBe("write");
    expect(TOOL_CLASSES.list_skills).toBe("read");
  });

  it("classifies Phase 3 cross-tab tools per the R7 split", () => {
    // Reads
    expect(TOOL_CLASSES.list_tabs).toBe("read");
    expect(TOOL_CLASSES.get_tab_content).toBe("read");
    expect(TOOL_CLASSES.activate_tab).toBe("read");
    // Writes
    expect(TOOL_CLASSES.close_tabs).toBe("write");
    expect(TOOL_CLASSES.group_tabs).toBe("write");
    expect(TOOL_CLASSES.ungroup_tabs).toBe("write");
    expect(TOOL_CLASSES.move_tabs).toBe("write");
  });

  it("getToolClass defaults unknown names (skill-resolved tools) to read", () => {
    expect(getToolClass("foo_skill_id")).toBe("read");
    expect(getToolClass("user-defined-skill-uuid")).toBe("read");
  });

  it("getToolClass returns the registered class for known names", () => {
    expect(getToolClass("click")).toBe("write");
    expect(getToolClass("list_tabs")).toBe("read");
  });

  it("every KNOWN_BUILT_IN_TOOL_NAMES entry has a class (build-time exhaustive)", () => {
    for (const name of KNOWN_BUILT_IN_TOOL_NAMES) {
      expect(TOOL_CLASSES[name]).toBeDefined();
    }
  });

  it("every TAB_TOOL_NAMES entry has a class (the test the G-1 gate is paired with)", () => {
    for (const name of TAB_TOOL_NAMES) {
      expect(TOOL_CLASSES[name]).toBeDefined();
    }
  });
});

describe("Phase 5 screenshot tools — names + classes", () => {
  it("capture_visible_tab and capture_fullpage_tab are registered", () => {
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("capture_visible_tab");
    expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("capture_fullpage_tab");
  });
  it("screenshot tools are class=read (no tab-state mutation)", () => {
    expect(getToolClass("capture_visible_tab")).toBe("read");
    expect(getToolClass("capture_fullpage_tab")).toBe("read");
  });
});
