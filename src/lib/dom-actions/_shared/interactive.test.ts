import { describe, it, expect } from "vitest";
import {
  INTERACTIVE_SELECTOR,
  ROLE_TO_CN,
  TAG_TO_CN,
  EDITOR_SELECTOR,
  EDITOR_ENGINE_MAP,
  WRAPPER_TAGS_LIST,
  TYPE_EDITOR_MARKERS,
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

describe("authoritative constants", () => {
  it("EDITOR_SELECTOR covers Monaco/CM5/CM6/TinyMCE v4+v6", () => {
    expect(EDITOR_SELECTOR).toBe(
      ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce",
    );
  });
  it("EDITOR_ENGINE_MAP maps each host class to an engine name", () => {
    expect(EDITOR_ENGINE_MAP).toEqual([
      [".monaco-editor", "Monaco"],
      [".cm-editor", "CodeMirror"],
      [".CodeMirror", "CodeMirror"],
      [".tox-tinymce", "TinyMCE"],
      [".mce-tinymce", "TinyMCE"],
    ]);
  });
  it("WRAPPER_TAGS_LIST matches the agent-layer master table", async () => {
    const { UNTRUSTED_WRAPPER_TAGS } = await import("../../agent/untrusted-wrappers");
    expect([...WRAPPER_TAGS_LIST]).toEqual([...UNTRUSTED_WRAPPER_TAGS]);
  });
  it("TYPE_EDITOR_MARKERS keeps the 9 type-diagnostic editors", () => {
    expect(TYPE_EDITOR_MARKERS.map((m) => m[1])).toEqual([
      "Slate", "ProseMirror", "Quill", "Lexical", "Monaco",
      "CodeMirror", "Feishu Docs", "Notion", "Google Docs",
    ]);
  });
});
