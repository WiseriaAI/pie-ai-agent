import { test, expect } from "bun:test";
import type {
  SrtWinSpawn,
  WindowsInstallResult,
  WindowsSandboxStatus,
} from "@anthropic-ai/sandbox-runtime";
import { runWindowsSandboxSetup, type WinSandboxDeps } from "../src/windows-sandbox-setup";
import { runCli } from "../src/cli";

// Windows 沙箱设施命令的可判定逻辑（真机 install/uninstall 走 need-human-test）。
// 覆盖两组：① 非 win32 恒 no-op、绝不触真 OS、退出码语义；② win32 分支经注入 deps
// 覆盖 UAC-cancel 语义 + status 结构化就绪判定（回归防护 FAIL-1：srt 的
// WindowsSandboxStatus 顶层没有 `installed` 字段，旧代码 `as`-断言读它恒未就绪）。

// ── ① 非 win32：恒 skipped no-op ────────────────────────────────────────────
test("runWindowsSandboxSetup: install is a skipped no-op off Windows", async () => {
  const r = await runWindowsSandboxSetup("install", { platform: "linux" });
  expect(r.skipped).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("no-op");
});

test("runWindowsSandboxSetup: uninstall is a skipped no-op off Windows", async () => {
  const r = await runWindowsSandboxSetup("uninstall", { platform: "darwin" });
  expect(r.skipped).toBe(true);
  expect(r.ok).toBe(false);
});

test("runWindowsSandboxSetup: status is a skipped no-op off Windows", async () => {
  const r = await runWindowsSandboxSetup("status", { platform: "linux" });
  expect(r.skipped).toBe(true);
  expect(r.ok).toBe(false);
});

// ── ② win32 分支（注入 deps；不触真 srt-win.exe）──────────────────────────────
const FAKE_SRT_WIN = { exe: "C:\\Pie Link\\srt-win.exe", prependArgs: [] } as unknown as SrtWinSpawn;

function makeDeps(over: Partial<WinSandboxDeps> = {}): WinSandboxDeps {
  return {
    resolveSrtWin: () => FAKE_SRT_WIN,
    installWindowsSandboxAsync: async () => ({}) as WindowsInstallResult,
    uninstallWindowsSandbox: () => ({}),
    checkWindowsSandboxStatusAsync: async () =>
      ({ user: { provisioned: true }, wfp: { state: "installed", filters: 1 } }) as WindowsSandboxStatus,
    ...over,
  };
}

test("win32 install: success → ok:true", async () => {
  const r = await runWindowsSandboxSetup("install", { platform: "win32", deps: makeDeps() });
  expect(r.skipped).toBe(false);
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("installed");
});

test("win32 install: UAC-cancelled → ok:false, detail flags cancelled (not a silent exit=0)", async () => {
  const deps = makeDeps({ installWindowsSandboxAsync: async () => ({ cancelled: true }) as WindowsInstallResult });
  const r = await runWindowsSandboxSetup("install", { platform: "win32", deps });
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("cancelled");
});

test("win32 uninstall: UAC-cancelled → ok:false", async () => {
  const deps = makeDeps({ uninstallWindowsSandbox: () => ({ cancelled: true }) });
  const r = await runWindowsSandboxSetup("uninstall", { platform: "win32", deps });
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("cancelled");
});

test("win32 status: provisioned + wfp installed → ready (ok:true)", async () => {
  const r = await runWindowsSandboxSetup("status", { platform: "win32", deps: makeDeps() });
  expect(r.ok).toBe(true);
});

test("win32 status: provisioned + wfp cannot-read (non-elevated) → still ready (no false negative)", async () => {
  const deps = makeDeps({
    checkWindowsSandboxStatusAsync: async () =>
      ({ user: { provisioned: true }, wfp: { state: "cannot-read", filters: 0 } }) as WindowsSandboxStatus,
  });
  const r = await runWindowsSandboxSetup("status", { platform: "win32", deps });
  expect(r.ok).toBe(true);
});

test("win32 status: wfp absent → not ready (ok:false)", async () => {
  const deps = makeDeps({
    checkWindowsSandboxStatusAsync: async () =>
      ({ user: { provisioned: true }, wfp: { state: "absent", filters: 0 } }) as WindowsSandboxStatus,
  });
  const r = await runWindowsSandboxSetup("status", { platform: "win32", deps });
  expect(r.ok).toBe(false);
});

test("win32 status: user not provisioned → not ready (ok:false)", async () => {
  const deps = makeDeps({
    checkWindowsSandboxStatusAsync: async () =>
      ({ user: { provisioned: false }, wfp: { state: "installed", filters: 1 } }) as WindowsSandboxStatus,
  });
  const r = await runWindowsSandboxSetup("status", { platform: "win32", deps });
  expect(r.ok).toBe(false);
});

test("win32: srt throwing is swallowed → ok:false, never throws (installer must not crash)", async () => {
  const deps = makeDeps({
    installWindowsSandboxAsync: async () => {
      throw new Error("srt-win boom");
    },
  });
  const r = await runWindowsSandboxSetup("install", { platform: "win32", deps });
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("error:");
  expect(r.detail).toContain("boom");
});

// ── CLI dispatch：install/uninstall best-effort → 恒 0；status → 就绪判定 ──────
test("cli windows-install returns 0 (best-effort, non-blocking) off Windows", async () => {
  expect(await runCli(["windows-install"])).toBe(0);
});

test("cli windows-uninstall returns 0 off Windows", async () => {
  expect(await runCli(["windows-uninstall"])).toBe(0);
});

test("cli windows-status returns 1 when facility not ready off Windows", async () => {
  expect(await runCli(["windows-status"])).toBe(1);
});
