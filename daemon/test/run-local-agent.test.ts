import { test, expect } from "bun:test";
import { runLocalAgent } from "../src/run-local-agent";

test("spawns target with prompt, returns stdout", async () => {
  const fakeSpawn = async (cmd: string, args: string[], cwd: string) => {
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("hello world");
    return { stdout: "AGENT REPLY", exitCode: 0 };
  };
  const ensureDirCalls: string[] = [];
  const fakeEnsureDir = (dir: string) => {
    ensureDirCalls.push(dir);
  };
  const r = await runLocalAgent(
    { target: "claude", prompt: "hello world" },
    { spawn: fakeSpawn, ensureDir: fakeEnsureDir },
  );
  expect(r.output).toBe("AGENT REPLY");
  expect(r.exitCode).toBe(0);
  expect(r.cwd).toContain("pie-handoffs"); // 默认临时 workspace
  // 证明 workspace 创建走注入的 ensureDir，而非真实文件系统 I/O
  expect(ensureDirCalls).toHaveLength(1);
  expect(ensureDirCalls[0]).toContain("pie-handoffs");
});

test("honors explicit cwd", async () => {
  const fakeSpawn = async (_c: string, _a: string[], cwd: string) => {
    expect(cwd).toBe("/tmp/proj");
    return { stdout: "ok", exitCode: 0 };
  };
  const fakeEnsureDir = (_dir: string) => {
    throw new Error("ensureDir should not be called when cwd is explicit");
  };
  const r = await runLocalAgent(
    { target: "claude", prompt: "x", cwd: "/tmp/proj" },
    { spawn: fakeSpawn, ensureDir: fakeEnsureDir },
  );
  expect(r.cwd).toBe("/tmp/proj");
});
