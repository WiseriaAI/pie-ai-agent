import { test, expect } from "bun:test";
import { runWindowsSandboxSetup } from "../src/windows-sandbox-setup";
import { runCli } from "../src/cli";

// Windows 沙箱设施命令的可判定逻辑（真机 install/uninstall 走 need-human-test）。
// 在 mac/linux 上覆盖的是「非 win32 恒 no-op、绝不触真 OS、退出码语义」这几项。

test("runWindowsSandboxSetup: install is a skipped no-op off Windows", async () => {
  const r = await runWindowsSandboxSetup("install", "linux");
  expect(r.skipped).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("no-op");
});

test("runWindowsSandboxSetup: uninstall is a skipped no-op off Windows", async () => {
  const r = await runWindowsSandboxSetup("uninstall", "darwin");
  expect(r.skipped).toBe(true);
  expect(r.ok).toBe(false);
});

test("runWindowsSandboxSetup: status is a skipped no-op off Windows", async () => {
  const r = await runWindowsSandboxSetup("status", "linux");
  expect(r.skipped).toBe(true);
  expect(r.ok).toBe(false);
});

// CLI dispatch：install/uninstall best-effort → 恒 0（安装器不能被非零码卡住）；
// status → 就绪判定（off-Windows 未就绪 → 1）。
test("cli windows-install returns 0 (best-effort, non-blocking) off Windows", async () => {
  expect(await runCli(["windows-install"])).toBe(0);
});

test("cli windows-uninstall returns 0 off Windows", async () => {
  expect(await runCli(["windows-uninstall"])).toBe(0);
});

test("cli windows-status returns 1 when facility not ready off Windows", async () => {
  expect(await runCli(["windows-status"])).toBe(1);
});
