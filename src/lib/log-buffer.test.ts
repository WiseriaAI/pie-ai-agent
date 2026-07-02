import { describe, it, expect, beforeEach } from "vitest";
import { appendLog, readRecentLogs, serialize } from "./log-buffer";
import { _resetForTests } from "./idb/db";

const H = 60 * 60 * 1000;

describe("log-buffer", () => {
  beforeEach(async () => { await _resetForTests(); });

  it("prunes entries older than 24h", async () => {
    const now = 100 * H;
    await appendLog({ ts: now - 25 * H, level: "warn", ctx: "sw", text: "old" });
    await appendLog({ ts: now, level: "error", ctx: "sw", text: "fresh" });
    const blob = await readRecentLogs(now);
    expect(blob).toContain("fresh");
    expect(blob).not.toContain("old");
  });

  it("caps at 500 entries, dropping oldest", async () => {
    const now = 100 * H;
    for (let i = 0; i < 505; i++) await appendLog({ ts: now, level: "warn", ctx: "sw", text: `e${i}` });
    const lines = (await readRecentLogs(now)).split("\n");
    expect(lines).toHaveLength(500);
    expect(lines[0].endsWith("e5")).toBe(true);
    expect(lines[499].endsWith("e504")).toBe(true);
  });

  it("serialize truncates to 500 chars and stringifies non-strings", () => {
    expect(serialize(["z".repeat(600)]).length).toBe(500);
    expect(serialize([{ a: 1 }, "x"])).toBe('{"a":1} x');
    expect(serialize([new Error("boom")])).toBe("Error: boom");
  });
});
