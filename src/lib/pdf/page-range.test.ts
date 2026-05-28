import { describe, it, expect } from "vitest";
import { parsePageRange } from "./page-range";

describe("parsePageRange", () => {
  it("parses single page", () => {
    expect(parsePageRange("1", 10)).toEqual([1]);
  });

  it("parses dash range", () => {
    expect(parsePageRange("1-3", 10)).toEqual([1, 2, 3]);
  });

  it("parses comma list", () => {
    expect(parsePageRange("1,3,5", 10)).toEqual([1, 3, 5]);
  });

  it("parses mixed", () => {
    expect(parsePageRange("1-3,7", 10)).toEqual([1, 2, 3, 7]);
  });

  it("deduplicates and sorts", () => {
    expect(parsePageRange("3,1-2,2,3", 10)).toEqual([1, 2, 3]);
  });

  it("ignores out-of-range pages without erroring", () => {
    expect(parsePageRange("1,100,3", 5)).toEqual([1, 3]);
    expect(parsePageRange("8-12", 10)).toEqual([8, 9, 10]);
  });

  it("treats empty / missing spec as first page", () => {
    expect(parsePageRange("", 10)).toEqual([1]);
    expect(parsePageRange(undefined, 10)).toEqual([1]);
  });

  it("treats reverse range as empty (don't silently swap)", () => {
    expect(parsePageRange("3-1", 10)).toEqual([]);
  });

  it("ignores whitespace", () => {
    expect(parsePageRange(" 1 - 3 , 5 ", 10)).toEqual([1, 2, 3, 5]);
  });

  it("returns empty for total=0", () => {
    expect(parsePageRange("1-3", 0)).toEqual([]);
  });
});
