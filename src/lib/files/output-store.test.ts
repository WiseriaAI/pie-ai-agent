import { describe, it, expect, beforeEach } from "vitest";
import {
  putArtifact,
  getArtifact,
  artifactExists,
  deleteSessionArtifacts,
  _clearAllForTests,
  type FileArtifact,
} from "./output-store";

function mk(id: string, sessionId: string, bytes = 100, addedAt = 1): FileArtifact {
  return { id, sessionId, filename: `pie/${id}.md`, mime: "text/markdown", content: "x".repeat(bytes), byteLength: bytes, addedAt };
}

describe("output-store (IndexedDB)", () => {
  beforeEach(async () => {
    await _clearAllForTests();
  });

  it("persists and retrieves by id", async () => {
    await putArtifact(mk("a", "s1"));
    expect((await getArtifact("a"))?.filename).toBe("pie/a.md");
    expect(await getArtifact("missing")).toBeUndefined();
  });

  it("artifactExists reflects presence", async () => {
    await putArtifact(mk("a", "s1"));
    expect(await artifactExists("a")).toBe(true);
    expect(await artifactExists("nope")).toBe(false);
  });

  it("LRU drops the oldest artifact when the session byte budget is exceeded", async () => {
    const big = 6 * 1024 * 1024; // 6MB each, budget 10MB
    await putArtifact(mk("old", "s1", big, 1));
    await putArtifact(mk("new", "s1", big, 2));
    expect(await getArtifact("old")).toBeUndefined();
    expect(await getArtifact("new")).toBeDefined();
  });

  it("LRU drops oldest beyond the 20-artifact count cap", async () => {
    for (let i = 0; i < 21; i++) await putArtifact(mk(`a${i}`, "s1", 10, i + 1));
    expect(await getArtifact("a0")).toBeUndefined(); // oldest evicted
    expect(await getArtifact("a20")).toBeDefined();
  });

  it("deleteSessionArtifacts removes only that session's artifacts", async () => {
    await putArtifact(mk("a", "s1"));
    await putArtifact(mk("b", "s1"));
    await putArtifact(mk("c", "s2"));
    await deleteSessionArtifacts("s1");
    expect(await getArtifact("a")).toBeUndefined();
    expect(await getArtifact("b")).toBeUndefined();
    expect(await getArtifact("c")).toBeDefined();
  });
});
