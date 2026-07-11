import { test, expect } from "bun:test";
import { join } from "path";
import { paths } from "../src/paths";

test("skill_fs paths sit under ~/.pie", () => {
  expect(paths.skillsDir).toBe(join(paths.pieDir, "skills"));
  expect(paths.grantsPath).toBe(join(paths.pieDir, "grants.json"));
  expect(paths.auditPath).toBe(join(paths.pieDir, "logs", "audit.jsonl"));
});
