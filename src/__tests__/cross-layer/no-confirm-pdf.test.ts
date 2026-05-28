import { describe, it, expect } from "vitest";
import {
  TOOL_CLASSES,
  getToolClass,
  KNOWN_BUILT_IN_TOOL_NAMES,
} from "@/lib/agent/tool-names";
import { PDF_TOOLS } from "@/lib/agent/tools/pdf";

describe("no-confirm-pdf — pdf tools are read-class and never enter confirm path", () => {
  it("declares read class for every pdf tool", () => {
    for (const t of PDF_TOOLS) {
      expect(getToolClass(t.name)).toBe("read");
    }
  });

  it("registers every pdf tool name in KNOWN_BUILT_IN_TOOL_NAMES and TOOL_CLASSES", () => {
    const known = new Set<string>(KNOWN_BUILT_IN_TOOL_NAMES);
    for (const t of PDF_TOOLS) {
      expect(known.has(t.name)).toBe(true);
      expect(TOOL_CLASSES[t.name]).toBe("read");
    }
  });
});
