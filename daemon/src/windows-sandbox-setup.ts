// Windows 脚本沙箱设施的安装/卸载/状态命令（spec docs/specs/2026-08-05-daemon-windows-support.md
// §3.2 / §4.5）。Inno 安装器提权阶段调 `pie.exe windows-install`（内部走 srt 的
// installWindowsSandboxAsync 建 srt-sandbox 账户 + 机器级 WFP 围栏）；卸载段调
// `pie.exe windows-uninstall` 逆操作。
//
// 关键约束：
// - **非 win32 恒 no-op**（mac/linux 上这些命令无意义；本地/CI 跑测试不触真 OS）。
// - **install/uninstall 是 best-effort**：设施失败/被取消**不阻断安装**（spec §3.2 fail-closed
//   ——桥接/skills/handoff 照常，只降级 run_skill_script）。故命令层吞异常、只报告，
//   安装器 [Code] 亦忽略退出码。
// - srt-win.exe 是安装器伴随文件（与 pie.exe 同目录），路径经 `srtWinPath()` 显式解出
//   （bun compile 单二进制无隐式 vendored 回落，spec §6.1）。
import { srtWinPath } from "./skill-sandbox";

export type WinSandboxAction = "install" | "uninstall" | "status";

export interface WinSandboxSetupResult {
  /** install/uninstall：操作成功；status：设施就绪。 */
  ok: boolean;
  /** 非 win32 平台被跳过（best-effort no-op）。 */
  skipped: boolean;
  /** 人读的一行摘要（安装器日志 / doctor 引用）。 */
  detail: string;
}

/**
 * 执行 Windows 沙箱设施命令。platform 可注入以便在 mac/linux 上覆盖 win32 分支的
 * 跳过语义（真机行为走 need-human-test）。
 *
 * - install：`installWindowsSandboxAsync`（一次 UAC；安装器已提权故内联完成）。
 * - uninstall：`uninstallWindowsSandbox`（清账户/WFP/ACE）。
 * - status：`checkWindowsSandboxStatusAsync`——就绪判定用 `installed` 布尔。
 *
 * 任一 srt 调用抛错都被吞成 `{ ok:false }` + 原因，绝不 throw（安装器不能因此崩）。
 */
export async function runWindowsSandboxSetup(
  action: WinSandboxAction,
  platform: NodeJS.Platform = process.platform,
): Promise<WinSandboxSetupResult> {
  if (platform !== "win32") {
    return { ok: false, skipped: true, detail: `no-op on ${platform} (Windows-only sandbox facility)` };
  }
  try {
    const srt = await import("@anthropic-ai/sandbox-runtime");
    const srtWin = srt.resolveSrtWin({ path: srtWinPath() });
    switch (action) {
      case "install": {
        const r = await srt.installWindowsSandboxAsync({ srtWin });
        return { ok: true, skipped: false, detail: `installed: ${safeJson(r)}` };
      }
      case "uninstall": {
        const r = srt.uninstallWindowsSandbox({ srtWin });
        return { ok: true, skipped: false, detail: `uninstalled: ${safeJson(r)}` };
      }
      case "status": {
        const r = await srt.checkWindowsSandboxStatusAsync({ srtWin });
        const installed = Boolean((r as { installed?: unknown } | null)?.installed);
        return { ok: installed, skipped: false, detail: `status: ${safeJson(r)}` };
      }
    }
  } catch (e) {
    return { ok: false, skipped: false, detail: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
