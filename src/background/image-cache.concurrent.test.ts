import { describe, expect, it, beforeEach } from "vitest";
import {
  addImage,
  evictSession,
  evictByInFlightSet,
  _getCacheSessionCount,
  _getCacheSizeBytes,
  _resetForTests,
} from "./image-cache";

describe("image-cache — multi-session no cross-eviction (#30)", () => {
  beforeEach(() => _resetForTests());

  it("retains session A's images when session B's cache is added", () => {
    addImage("a", new Uint8Array([1, 2, 3]).buffer);
    addImage("b", new Uint8Array([4, 5, 6]).buffer);
    expect(_getCacheSessionCount()).toBe(2);
    expect(_getCacheSizeBytes("a")).toBe(3);
    expect(_getCacheSizeBytes("b")).toBe(3);
  });

  it("R13(a) evictSession only clears the named session", () => {
    addImage("a", new Uint8Array([1, 2, 3]).buffer);
    addImage("b", new Uint8Array([4, 5, 6]).buffer);
    evictSession("a");
    expect(_getCacheSizeBytes("a")).toBe(0);
    expect(_getCacheSizeBytes("b")).toBe(3);
  });

  it("R13(d) evictByInFlightSet preserves sessions not in the set", () => {
    addImage("a", new Uint8Array([1]).buffer);
    addImage("b", new Uint8Array([2]).buffer);
    addImage("c", new Uint8Array([3]).buffer);
    evictByInFlightSet(["a", "c"]);
    expect(_getCacheSizeBytes("a")).toBe(0);
    expect(_getCacheSizeBytes("b")).toBe(1);
    expect(_getCacheSizeBytes("c")).toBe(0);
  });
});
