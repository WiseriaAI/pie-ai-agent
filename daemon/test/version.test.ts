import { describe, expect, test } from "bun:test";
import { DAEMON_VERSION } from "../src/version";
import { handleMessage } from "../src/daemon";
import { runCli } from "../src/cli";

describe("daemon version", () => {
  test("DAEMON_VERSION 回落 package.json version", () => {
    expect(DAEMON_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("hello 响应带 daemonVersion", async () => {
    const out = await handleMessage(
      JSON.stringify({ id: "1", method: "hello", params: { protocolVersion: 1 } }),
    );
    const res = JSON.parse(out);
    expect(res.ok).toBe(true);
    expect(res.result.daemonVersion).toBe(DAEMON_VERSION);
  });

  test("pie --version / version 打印版本号并返回 0", async () => {
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      expect(await runCli(["--version"])).toBe(0);
      expect(await runCli(["version"])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logged).toEqual([DAEMON_VERSION, DAEMON_VERSION]);
  });
});
