import { describe, it, expect, beforeEach } from "vitest";
import {
  addImage, getImages, getImagesByUserTurn, getImageById,
  evictSession, evictAllOnSWStartup, evictOnSetActive, evictByInFlightSet,
  _resetForTests,
} from "./image-cache";
import type { ImageRef } from "@/lib/images";

const mkRef = (id: string, sessionId: string, userTurnId: string, bytes = 1_000_000): ImageRef => ({
  id, userTurnId, mediaType: "image/jpeg", data: "AAAA",
  width: 1568, height: 1045, byteLength: bytes, addedAt: Date.now(),
});

beforeEach(() => _resetForTests());

describe("image-cache — basic", () => {
  it("addImage + getImages round-trip", () => {
    addImage("s1", mkRef("i1", "s1", "t1"));
    expect(getImages("s1").map((r) => r.id)).toEqual(["i1"]);
  });
  it("getImagesByUserTurn returns only that turn", () => {
    addImage("s1", mkRef("i1", "s1", "t1"));
    addImage("s1", mkRef("i2", "s1", "t2"));
    expect(getImagesByUserTurn("s1", "t1").map((r) => r.id)).toEqual(["i1"]);
  });
  it("getImageById finds an image by id, undefined if missing", () => {
    addImage("s1", mkRef("i1", "s1", "t1"));
    expect(getImageById("s1", "i1")?.id).toBe("i1");
    expect(getImageById("s1", "missing")).toBeUndefined();
    expect(getImageById("nonexistent-session", "i1")).toBeUndefined();
  });
});

describe("image-cache — LRU 30 MB byte budget", () => {
  it("oldest turn is dropped when total > 30 MB", () => {
    addImage("s1", mkRef("i1", "s1", "t1", 12_000_000));
    addImage("s1", mkRef("i2", "s1", "t2", 12_000_000));
    addImage("s1", mkRef("i3", "s1", "t3", 12_000_000));
    // 36 MB > 30 MB → t1 evicted
    expect(getImages("s1").map((r) => r.id)).toEqual(["i2", "i3"]);
  });

  it("respects last-3-turn cap even within byte budget", () => {
    addImage("s1", { ...mkRef("i1", "s1", "t1", 1_000_000), addedAt: 1 });
    addImage("s1", { ...mkRef("i2", "s1", "t2", 1_000_000), addedAt: 2 });
    addImage("s1", { ...mkRef("i3", "s1", "t3", 1_000_000), addedAt: 3 });
    addImage("s1", { ...mkRef("i4", "s1", "t4", 1_000_000), addedAt: 4 });
    expect(getImages("s1").map((r) => r.id)).toEqual(["i2", "i3", "i4"]);
  });

  it("same-turn images are atomic — multiple images of t1 stay together", () => {
    addImage("s1", { ...mkRef("i1a", "s1", "t1", 2_000_000), addedAt: 1 });
    addImage("s1", { ...mkRef("i1b", "s1", "t1", 2_000_000), addedAt: 1 });
    addImage("s1", mkRef("i2", "s1", "t2", 1_000_000));
    addImage("s1", mkRef("i3", "s1", "t3", 1_000_000));
    addImage("s1", mkRef("i4", "s1", "t4", 1_000_000));
    // 4 turns > 3 cap → t1 evicted (both images go together)
    expect(getImages("s1").map((r) => r.id)).toEqual(["i2", "i3", "i4"]);
  });
});

describe("image-cache — 4 evict paths (R13)", () => {
  it("(a) evictSession only drops the named session", () => {
    addImage("s1", mkRef("i1", "s1", "t1"));
    addImage("s2", mkRef("i2", "s2", "t1"));
    evictSession("s1");
    expect(getImages("s1")).toEqual([]);
    expect(getImages("s2").length).toBe(1);
  });

  it("(b) evictAllOnSWStartup wipes everything", () => {
    addImage("s1", mkRef("i1", "s1", "t1"));
    addImage("s2", mkRef("i2", "s2", "t1"));
    evictAllOnSWStartup();
    expect(getImages("s1")).toEqual([]);
    expect(getImages("s2")).toEqual([]);
  });

  // Function-body unit test retained — SW path no longer calls this since
  // #30 (concurrent sessions). Kept exported for any future user-driven
  // explicit-clear surface.
  it("(c) evictOnSetActive keeps only the newly active session", () => {
    addImage("s1", mkRef("i1", "s1", "t1"));
    addImage("s2", mkRef("i2", "s2", "t1"));
    evictOnSetActive("s2");
    expect(getImages("s1")).toEqual([]);
    expect(getImages("s2").length).toBe(1);
  });

  it("(d) evictByInFlightSet drops only the listed sessions", () => {
    addImage("s1", mkRef("i1", "s1", "t1"));
    addImage("s2", mkRef("i2", "s2", "t1"));
    addImage("s3", mkRef("i3", "s3", "t1"));
    evictByInFlightSet(["s1", "s3"]);
    expect(getImages("s1")).toEqual([]);
    expect(getImages("s2").length).toBe(1);
    expect(getImages("s3")).toEqual([]);
  });
});
