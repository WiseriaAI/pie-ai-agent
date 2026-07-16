import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realSpawn } from "../src/spawn";

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  // realpath：macOS 上 tmpdir 是 /var → /private/var symlink，子进程 PWD 会被解成真实路径。
  const d = realpathSync(mkdtempSync(join(tmpdir(), "pie-spawn-")));
  created.push(d);
  return d;
}

// 回归守卫（#307 真机验收）：realSpawn 必须把子进程的 PWD env 覆写成 cwd。
// 否则子进程继承 daemon 进程的 PWD（= daemon 启动目录），opencode 等信 PWD 胜过
// getcwd 的后端会把文件写进错误目录。printenv 直接读 PWD env，精确复现该泄漏。
test("realSpawn overrides child PWD env to cwd (not the daemon's PWD)", async () => {
  const dir = tempDir();
  const stale = tempDir(); // 模拟 daemon 启动目录残留在 process.env.PWD 上
  const prev = process.env.PWD;
  process.env.PWD = stale;
  try {
    const { stdout, exitCode } = await realSpawn("printenv", ["PWD"], dir);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(dir);
    expect(stdout.trim()).not.toBe(stale);
  } finally {
    if (prev === undefined) delete process.env.PWD;
    else process.env.PWD = prev;
  }
});

// getcwd 也必须指向 cwd（PWD 覆写不应把 getcwd 带偏）。
test("realSpawn runs the child process in cwd", async () => {
  const dir = tempDir();
  const { stdout, exitCode } = await realSpawn("pwd", [], dir);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(dir);
});
