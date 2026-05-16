import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safeSendMessage } from "./safe-send-message";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  // @ts-expect-error reset
  delete globalThis.chrome;
});

describe("safeSendMessage", () => {
  it("succeeds quietly when sendMessage resolves", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    // @ts-expect-error stub
    globalThis.chrome = { runtime: { sendMessage } };

    safeSendMessage({ type: "x" });
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith({ type: "x" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("surfaces console.error on synchronous throw", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("Extension context invalidated");
    });
    // @ts-expect-error stub
    globalThis.chrome = { runtime: { sendMessage } };

    safeSendMessage({ type: "x" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("orphaned content script");
  });

  it("surfaces console.error on async rejection", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("port closed"));
    // @ts-expect-error stub
    globalThis.chrome = { runtime: { sendMessage } };

    safeSendMessage({ type: "x" });
    await new Promise((r) => setTimeout(r, 0));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("orphaned content script");
  });

  it("handles non-promise return without throwing", () => {
    const sendMessage = vi.fn().mockReturnValue(undefined);
    // @ts-expect-error stub
    globalThis.chrome = { runtime: { sendMessage } };

    expect(() => safeSendMessage({ type: "x" })).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
