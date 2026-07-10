import { test, expect } from "bun:test";
import { handleMessage } from "../src/daemon";
import { setLogEnabled } from "../src/log";

setLogEnabled(false);

test("hello advertises skill_fs", async () => {
  const out = JSON.parse(await handleMessage(JSON.stringify({ id: "1", method: "hello", params: { protocolVersion: 1 } })));
  expect(out.ok).toBe(true);
  expect(out.result.capabilities).toContain("skill_fs");
});

test("list_skills returns ok envelope (empty when no skills dir)", async () => {
  const out = JSON.parse(await handleMessage(JSON.stringify({ id: "2", method: "list_skills", params: {} })));
  expect(out.ok).toBe(true);
  expect(Array.isArray(out.result.skills)).toBe(true);
});

test("unknown_method still handled", async () => {
  const out = JSON.parse(await handleMessage(JSON.stringify({ id: "3", method: "nope", params: {} })));
  expect(out.ok).toBe(false);
  expect(out.error.code).toBe("unknown_method");
});

test("run_skill_script on missing skill → ok:false with unknown_skill code (not a hang)", async () => {
  const out = JSON.parse(await handleMessage(JSON.stringify({ id: "4", method: "run_skill_script", params: { name: "nope-skill", entry: "x.ts" } })));
  expect(out.ok).toBe(false);
  expect(out.error.code).toBe("unknown_skill");
});
