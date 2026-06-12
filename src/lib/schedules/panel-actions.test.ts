// src/lib/schedules/panel-actions.test.ts
//
// Task 9 — panel write-channel client. The branch unique to this module is the
// "SW returned undefined" fallback (a SW that idled / a handler that didn't
// respond). chrome.runtime.sendMessage is stubbed.

import { describe, it, expect, vi, afterEach } from "vitest";
import { deleteSchedule } from "./panel-actions";

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

describe("panel-actions send()", () => {
  it("returns { ok:false } when the SW responds with undefined", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    };
    const res = await deleteSchedule("sched_x");
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toMatch(/no response/i);
  });

  it("returns { ok:false } when sendMessage rejects", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage: vi.fn().mockRejectedValue(new Error("port closed")) },
    };
    const res = await deleteSchedule("sched_x");
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toMatch(/port closed/i);
  });

  it("forwards the SW response through on success", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, id: "sched_new" });
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage },
    };
    const res = await deleteSchedule("sched_y");
    expect(res).toEqual({ ok: true, id: "sched_new" });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "schedule-action",
      action: "delete",
      payload: { id: "sched_y" },
    });
  });
});
