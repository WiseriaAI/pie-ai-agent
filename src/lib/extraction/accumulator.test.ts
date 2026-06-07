import { describe, it, expect, beforeEach } from "vitest";
import { appendRows, getAccumulated, clearAccumulated } from "./accumulator";
import type { ExtractionRow } from "./types";

const row = (n: number, page = 1): ExtractionRow => ({ id: n, _source: { page, url: `https://x/p${page}` } });

describe("extraction accumulator", () => {
  beforeEach(() => { clearAccumulated("s1"); clearAccumulated("s2"); });

  it("逐页累积,返回运行总数", () => {
    expect(appendRows("s1", [row(1)], { reset: true, schema: [{ name: "id", type: "number" }] })).toBe(1);
    expect(appendRows("s1", [row(2, 2), row(3, 2)])).toBe(3);
    const acc = getAccumulated("s1")!;
    expect(acc.rows.length).toBe(3);
    expect(acc.schema[0].name).toBe("id");
  });

  it("reset 清掉上一轮", () => {
    appendRows("s1", [row(1)], { reset: true });
    appendRows("s1", [row(2)], { reset: true, schema: [{ name: "id", type: "number" }] });
    expect(getAccumulated("s1")!.rows.length).toBe(1);
  });

  it("会话隔离", () => {
    appendRows("s1", [row(1)], { reset: true });
    appendRows("s2", [row(9)], { reset: true });
    expect(getAccumulated("s1")!.rows.length).toBe(1);
    expect(getAccumulated("s2")!.rows[0].id).toBe(9);
  });

  it("首次无 reset 也会初始化", () => {
    expect(appendRows("s1", [row(1)])).toBe(1);
    expect(getAccumulated("s1")!.rows.length).toBe(1);
  });

  it("clearAccumulated 清空", () => {
    appendRows("s1", [row(1)], { reset: true });
    clearAccumulated("s1");
    expect(getAccumulated("s1")).toBeUndefined();
  });
});
