import { describe, expect, it, beforeEach } from "vitest";
import type { ImageRef } from "@/lib/images";
import {
  addImage,
  evictSession,
  evictByInFlightSet,
  _getCacheSessionCount,
  _getCacheSizeBytes,
  _resetForTests,
} from "./image-cache";

// Helper: the tests only care about eviction logic, not ImageRef field values,
// so we pass a minimal stub cast to ImageRef.
function buf(bytes: number[]): ImageRef {
  return new Uint8Array(bytes).buffer as unknown as ImageRef;
}

describe("image-cache — multi-session no cross-eviction (#30)", () => {
  beforeEach(() => _resetForTests());

  it("retains session A's images when session B's cache is added", () => {
    addImage("a", buf([1, 2, 3]));
    addImage("b", buf([4, 5, 6]));
    expect(_getCacheSessionCount()).toBe(2);
    expect(_getCacheSizeBytes("a")).toBe(3);
    expect(_getCacheSizeBytes("b")).toBe(3);
  });

  it("R13(a) evictSession only clears the named session", () => {
    addImage("a", buf([1, 2, 3]));
    addImage("b", buf([4, 5, 6]));
    evictSession("a");
    expect(_getCacheSizeBytes("a")).toBe(0);
    expect(_getCacheSizeBytes("b")).toBe(3);
  });

  it("R13(d) evictByInFlightSet preserves sessions not in the set", () => {
    addImage("a", buf([1]));
    addImage("b", buf([2]));
    addImage("c", buf([3]));
    evictByInFlightSet(["a", "c"]);
    expect(_getCacheSizeBytes("a")).toBe(0);
    expect(_getCacheSizeBytes("b")).toBe(1);
    expect(_getCacheSizeBytes("c")).toBe(0);
  });
});
