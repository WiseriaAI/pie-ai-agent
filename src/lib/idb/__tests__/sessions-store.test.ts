import { describe, it, expect, beforeEach } from "vitest";
import {
  putSessionRecord, getSessionRecord, removeSessionRecord,
  getIndex, writeSessionBatch,
} from "../sessions-store";
import { _resetForTests } from "../db";

beforeEach(async () => { await _resetForTests(); });

describe("sessions-store", () => {
  it("put/get/remove a session record", async () => {
    await putSessionRecord("s1:meta", { title: "hi" });
    expect(await getSessionRecord<{ title: string }>("s1:meta")).toEqual({ title: "hi" });
    await removeSessionRecord("s1:meta");
    expect(await getSessionRecord("s1:meta")).toBeUndefined();
  });

  it("getIndex defaults to empty array", async () => {
    expect(await getIndex()).toEqual([]);
  });

  it("writeSessionBatch writes records + index atomically; undefined removes", async () => {
    await putSessionRecord("s1:agent", { stepIndex: 3 });
    await writeSessionBatch({
      records: { "s1:meta": { title: "x" }, "s1:agent": undefined },
      index: [{ id: "s1", title: "x", status: "active", lastAccessedAt: 1 } as any],
    });
    expect(await getSessionRecord<{ title: string }>("s1:meta")).toEqual({ title: "x" });
    expect(await getSessionRecord("s1:agent")).toBeUndefined();
    expect(await getIndex()).toHaveLength(1);
  });
});
