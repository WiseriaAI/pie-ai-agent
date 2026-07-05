import { test, expect } from "bun:test";
import { runCli } from "../src/cli";

test("unknown subcommand returns non-zero", async () => {
  const code = await runCli(["bogus"]);
  expect(code).not.toBe(0);
});

test("doctor subcommand runs and returns 0 or 1", async () => {
  const code = await runCli(["doctor"]);
  expect([0, 1]).toContain(code);
});
