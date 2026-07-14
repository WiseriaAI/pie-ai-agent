import { test, expect } from "bun:test";
import { join } from "path";
import { paths, assertSessionId, sessionWorkspace } from "../src/paths";

test("skill_fs paths sit under ~/.pie", () => {
  expect(paths.skillsDir).toBe(join(paths.pieDir, "skills"));
  expect(paths.grantsPath).toBe(join(paths.pieDir, "grants.json"));
  expect(paths.auditPath).toBe(join(paths.pieDir, "logs", "audit.jsonl"));
  expect(paths.sessionsDir).toBe(join(paths.pieDir, "sessions"));
});

const VALID_SID = "12345678-1234-4321-abcd-1234567890ab";

test("assertSessionId accepts a UUID-shaped id", () => {
  expect(assertSessionId(VALID_SID)).toBe(VALID_SID);
});

test("assertSessionId rejects traversal / absolute / empty / oversize / junk", () => {
  for (const bad of [
    "..",
    "../../etc",
    "/abs/path",
    "",
    "a".repeat(200),
    "not-a-uuid",
    "12345678-1234-4321-abcd-1234567890a", // one short
    "12345678/1234/4321/abcd/1234567890ab",
  ]) {
    expect(() => assertSessionId(bad)).toThrow();
  }
});

test("sessionWorkspace joins under sessions root with /workspace suffix", () => {
  expect(sessionWorkspace(VALID_SID, "/tmp/s")).toBe(join("/tmp/s", VALID_SID, "workspace"));
  expect(sessionWorkspace(VALID_SID)).toBe(join(paths.sessionsDir, VALID_SID, "workspace"));
});

test("sessionWorkspace rejects a bad session id", () => {
  expect(() => sessionWorkspace("../evil", "/tmp/s")).toThrow();
});
