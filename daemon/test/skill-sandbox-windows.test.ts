import { test, expect } from "bun:test";
import { cmdQuote, cmdEnvPrefix, buildWindowsCommand } from "../src/skill-sandbox";

// Windows 沙箱命令组装的纯逻辑（spec §3.1 + 实测发现 F3）。真机沙箱强制走 need-human-test；
// 此处只测 mac/linux 上可判定的字符串构造：cmd 引号语义 + env 内联 set 链。

// ── cmdQuote（cmd.exe 引号语义，非 POSIX 单引号）─────────────────────────────
test("cmdQuote: wraps each argv element in double quotes", () => {
  expect(cmdQuote(["C:\\Pie\\pie.exe", "run", "C:\\skill\\scripts\\fetch.ts"])).toBe(
    '"C:\\Pie\\pie.exe" "run" "C:\\skill\\scripts\\fetch.ts"',
  );
});

test("cmdQuote: paths with spaces stay inside one quoted token", () => {
  expect(cmdQuote(["C:\\Users\\John Doe\\pie.exe", "run", "s.ts"])).toBe(
    '"C:\\Users\\John Doe\\pie.exe" "run" "s.ts"',
  );
});

test("cmdQuote: embedded double-quote escaped as \"\" (CommandLineToArgvW convention)", () => {
  expect(cmdQuote(['a"b'])).toBe('"a""b"');
});

test("cmdQuote: empty argv → empty string", () => {
  expect(cmdQuote([])).toBe("");
});

// ── cmdEnvPrefix（F3：broker env 不穿透，改走 cmd 内联 set 链）────────────────
test("cmdEnvPrefix: emits a `set \"K=V\" && ` chain in order", () => {
  expect(cmdEnvPrefix({ BUN_BE_BUN: "1", PIE_SKILL_DIR: "C:\\s", PIE_WORKSPACE: "C:\\ws" })).toBe(
    'set "BUN_BE_BUN=1" && set "PIE_SKILL_DIR=C:\\s" && set "PIE_WORKSPACE=C:\\ws" && ',
  );
});

test("cmdEnvPrefix: values with spaces stay quoted inside set", () => {
  expect(cmdEnvPrefix({ PIE_WORKSPACE: "C:\\Users\\John Doe\\ws" })).toBe(
    'set "PIE_WORKSPACE=C:\\Users\\John Doe\\ws" && ',
  );
});

test("cmdEnvPrefix: empty env → empty prefix", () => {
  expect(cmdEnvPrefix({})).toBe("");
});

// ── buildWindowsCommand：env 前缀 + quoted argv 拼成一条 cmd 命令串 ─────────────
test("buildWindowsCommand: prefixes env set-chain before the quoted argv (S6b shape)", () => {
  const cmd = buildWindowsCommand(
    ["C:\\Pie\\pie.exe", "run", "C:\\skill\\scripts\\fetch.ts"],
    { BUN_BE_BUN: "1" },
  );
  expect(cmd).toBe('set "BUN_BE_BUN=1" && "C:\\Pie\\pie.exe" "run" "C:\\skill\\scripts\\fetch.ts"');
});

test("buildWindowsCommand: no env → bare quoted argv", () => {
  expect(buildWindowsCommand(["C:\\a.exe", "x"], {})).toBe('"C:\\a.exe" "x"');
});
