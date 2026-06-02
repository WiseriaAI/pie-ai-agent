import { describe, it, expect } from "vitest";
import {
  INTERACTIVE_SELECTOR,
  ROLE_TO_CN,
  TAG_TO_CN,
} from "./interactive";

describe("_shared/interactive", () => {
  it("INTERACTIVE_SELECTOR 是单一字符串且覆盖 page-snapshot 口径", () => {
    expect(typeof INTERACTIVE_SELECTOR).toBe("string");
    for (const needle of [
      "a", "button", "input", "select", "textarea",
      '[role="button"]', '[role="checkbox"]', '[role="switch"]',
      '[contenteditable="true"]', "summary", "[onclick]",
      "[tabindex]:not([tabindex='-1'])",
    ]) {
      expect(INTERACTIVE_SELECTOR).toContain(needle);
    }
  });

  it("kind 映射含中文", () => {
    expect(ROLE_TO_CN.checkbox).toBe("复选框");
    expect(TAG_TO_CN.button).toBe("按钮");
  });
});
