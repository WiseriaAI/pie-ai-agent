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

// Finding 1 follow-up: stderr must be drained concurrently with stdout (never
// awaited-then-read), and a non-zero exit should carry a stderr tail in
// `output` so failures aren't silently empty. Zero exit stays untouched.
test("zero exit: output is stdout unchanged even when stderr has content", async () => {
  const fakeSpawn = async () => ({ stdout: "AGENT REPLY", exitCode: 0, stderr: "some warning noise" });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {} },
  );
  expect(r.output).toBe("AGENT REPLY");
  expect(r.exitCode).toBe(0);
});

test("non-zero exit: stderr tail is appended to output for diagnostics", async () => {
  const fakeSpawn = async () => ({ stdout: "", exitCode: 1, stderr: "boom: something broke\n" });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {} },
  );
  expect(r.exitCode).toBe(1);
  expect(r.output).toContain("boom: something broke");
});

test("non-zero exit: stdout and stderr tail are both present, stdout first", async () => {
  const fakeSpawn = async () => ({ stdout: "partial output", exitCode: 2, stderr: "fatal error" });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {} },
  );
  expect(r.output.indexOf("partial output")).toBeLessThan(r.output.indexOf("fatal error"));
});

test("non-zero exit with no stderr: output stays as stdout (no stray tail)", async () => {
  const fakeSpawn = async () => ({ stdout: "still nothing", exitCode: 1, stderr: "" });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {} },
  );
  expect(r.output).toBe("still nothing");
});

test("non-zero exit: fake spawn omitting stderr entirely does not throw", async () => {
  // Backward-compat: SpawnFn.stderr is optional; older/simpler fakes may omit it.
  const fakeSpawn = async () => ({ stdout: "x", exitCode: 1 });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {} },
  );
  expect(r.output).toBe("x");
  expect(r.exitCode).toBe(1);
});
