import { describe, it, expect, beforeEach } from "vitest";
import {
  addArtifact, getArtifact, evictSession, evictAllOnSWStartup,
  evictOnSetActive, evictByInFlightSet, _resetForTests, _getCacheSessionCount,
} from "./output-cache";
import type { FileArtifact } from "./output-cache";

function mk(id: string, sessionId: string, bytes = 100, addedAt = 1): FileArtifact {
  return { id, sessionId, filename: `pie/${id}.md`, mime: "text/markdown", content: "x".repeat(bytes), byteLength: bytes, addedAt };
}

describe("output-cache", () => {
  beforeEach(() => _resetForTests());

  it("stores and retrieves by (sessionId, id)", () => {
    addArtifact("s1", mk("a", "s1"));
    expect(getArtifact("s1", "a")?.filename).toBe("pie/a.md");
    expect(getArtifact("s1", "missing")).toBeUndefined();
    expect(getArtifact("s2", "a")).toBeUndefined();
  });

  it("LRU drops oldest artifact when byte budget exceeded", () => {
    const big = 6 * 1024 * 1024; // 6MB each, budget 10MB
    addArtifact("s1", mk("old", "s1", big, 1));
    addArtifact("s1", mk("new", "s1", big, 2));
    expect(getArtifact("s1", "old")).toBeUndefined();
    expect(getArtifact("s1", "new")).toBeDefined();
  });

  it("(a) evictSession only drops the named session", () => {
    addArtifact("s1", mk("a", "s1")); addArtifact("s2", mk("b", "s2"));
    evictSession("s1");
    expect(getArtifact("s1", "a")).toBeUndefined();
    expect(getArtifact("s2", "b")).toBeDefined();
  });

  it("(b) evictAllOnSWStartup wipes everything", () => {
    addArtifact("s1", mk("a", "s1")); addArtifact("s2", mk("b", "s2"));
    evictAllOnSWStartup();
    expect(_getCacheSessionCount()).toBe(0);
  });

  it("(c) evictOnSetActive keeps only the newly active session", () => {
    addArtifact("s1", mk("a", "s1")); addArtifact("s2", mk("b", "s2"));
    evictOnSetActive("s2");
    expect(getArtifact("s1", "a")).toBeUndefined();
    expect(getArtifact("s2", "b")).toBeDefined();
  });

  it("(d) evictByInFlightSet drops only the listed sessions", () => {
    addArtifact("s1", mk("a", "s1")); addArtifact("s2", mk("b", "s2"));
    evictByInFlightSet(["s1"]);
    expect(getArtifact("s1", "a")).toBeUndefined();
    expect(getArtifact("s2", "b")).toBeDefined();
  });
});
