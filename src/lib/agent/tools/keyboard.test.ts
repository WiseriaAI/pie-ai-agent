import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildKeyboardTools } from "./keyboard";
import type { CdpSession } from "../../../background/cdp-session";
import type { ActionResult } from "../../dom-actions/types";
import type { ToolHandlerContext } from "../types";
import { chromeMock } from "../../../test/setup";

// CDP modifier bitmask: Shift = 8 (others: Alt 1, Ctrl 2, Meta 4).
const SHIFT_MODIFIER = 8;

const TAB_ID = 1234;
const ORIGIN = "https://docs.example.com";

interface SendCall {
  method: string;
  params?: Record<string, unknown>;
}

function makeFakeSession(): { session: CdpSession; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const session: CdpSession = {
    tabId: TAB_ID,
    ownerToken: { sessionId: "sess-1", tabId: TAB_ID },
    generationId: 1,
    isAlive: true,
    detachedReason: null,
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    }),
    detach: vi.fn(async () => {}),
  };
  return { session, calls };
}

function seedActiveTab(): void {
  chromeMock.tabs.__tabsById.set(TAB_ID, {
    id: TAB_ID,
    url: `${ORIGIN}/doc/abc`,
    active: true,
  });
}

function ctx(): ToolHandlerContext {
  return {
    tabId: TAB_ID,
    signal: new AbortController().signal,
  } as unknown as ToolHandlerContext;
}

describe("dispatch_keyboard_input — softBreak", () => {
  let acquired: { session: CdpSession; calls: SendCall[] };

  beforeEach(() => {
    seedActiveTab();
    acquired = makeFakeSession();
  });

  function getDispatchTool() {
    const tools = buildKeyboardTools({
      acquireSession: async () => acquired.session,
      pinnedOrigin: ORIGIN,
    });
    const tool = tools.find((t) => t.name === "dispatch_keyboard_input");
    if (!tool) throw new Error("dispatch_keyboard_input tool not found");
    return tool;
  }

  function getKeyDownEvents(): SendCall[] {
    return acquired.calls.filter(
      (c) => c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown",
    );
  }

  it("default (softBreak omitted) — newlines send Enter without Shift modifier", async () => {
    const tool = getDispatchTool();
    const result = (await tool.handler({ text: "line1\nline2" }, ctx())) as ActionResult;

    expect(result.success).toBe(true);
    const keyDowns = getKeyDownEvents();
    expect(keyDowns).toHaveLength(1);
    expect(keyDowns[0].params?.key).toBe("Enter");
    // No modifiers field, OR modifiers === 0. Both are equivalent in CDP semantics
    // (omitted = 0). Treat as "no Shift bit set".
    const mods = (keyDowns[0].params?.modifiers as number | undefined) ?? 0;
    expect(mods & SHIFT_MODIFIER).toBe(0);
  });

  it("softBreak=true — every newline sends Shift+Enter (modifiers includes Shift bit)", async () => {
    const tool = getDispatchTool();
    const result = (await tool.handler(
      { text: "line1\nline2\nline3", softBreak: true },
      ctx(),
    )) as ActionResult;

    expect(result.success).toBe(true);
    const keyDowns = getKeyDownEvents();
    expect(keyDowns).toHaveLength(2);
    for (const evt of keyDowns) {
      expect(evt.params?.key).toBe("Enter");
      const mods = (evt.params?.modifiers as number | undefined) ?? 0;
      expect(mods & SHIFT_MODIFIER).toBe(SHIFT_MODIFIER);
    }
  });

  it("softBreak=true with no newline — no key event sent, only insertText", async () => {
    const tool = getDispatchTool();
    const result = (await tool.handler(
      { text: "single line", softBreak: true },
      ctx(),
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(getKeyDownEvents()).toHaveLength(0);
    const inserts = acquired.calls.filter((c) => c.method === "Input.insertText");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.text).toBe("single line");
  });

  it("softBreak=false — explicit false matches default (no Shift)", async () => {
    const tool = getDispatchTool();
    const result = (await tool.handler(
      { text: "a\nb", softBreak: false },
      ctx(),
    )) as ActionResult;

    expect(result.success).toBe(true);
    const keyDowns = getKeyDownEvents();
    expect(keyDowns).toHaveLength(1);
    const mods = (keyDowns[0].params?.modifiers as number | undefined) ?? 0;
    expect(mods & SHIFT_MODIFIER).toBe(0);
  });
});
