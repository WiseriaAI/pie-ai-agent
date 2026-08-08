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
import type {
  SrtWinSpawn,
  WindowsInstallResult,
  WindowsSandboxStatus,
} from "@anthropic-ai/sandbox-runtime";
import { srtWinPath } from "./skill-sandbox";

export type WinSandboxAction = "install" | "uninstall" | "status";

export interface WinSandboxSetupResult {
  /** install/uninstall：操作成功（且未被 UAC 取消）；status：设施就绪。 */
  ok: boolean;
  /** 非 win32 平台被跳过（best-effort no-op）。 */
  skipped: boolean;
  /** 人读的一行摘要（安装器日志 / doctor 引用）。 */
  detail: string;
}

/**
 * srt Windows 沙箱后端里本模块用到的四个入口，抽成接口以便在 mac/linux 上注入
 * 覆盖 win32 分支（真机行为仍走 need-human-test，但退出码 / 就绪判定 / cancel 语义
 * 这类可判定逻辑必须有单测兜底——否则形状错误会像 FAIL-1 那样被 `as` 断言吞掉）。
 */
export interface WinSandboxDeps {
  resolveSrtWin(cfg: { path: string }): SrtWinSpawn;
  installWindowsSandboxAsync(opts: { srtWin: SrtWinSpawn }): Promise<WindowsInstallResult>;
  uninstallWindowsSandbox(opts: { srtWin: SrtWinSpawn }): { cancelled?: true };
  checkWindowsSandboxStatusAsync(opts: { srtWin: SrtWinSpawn }): Promise<WindowsSandboxStatus>;
}

export interface WinSandboxSetupOptions {
  /** 覆盖平台判定（非 win32 恒跳过）。默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 注入 srt 依赖（测试用）。默认动态 import 官方 `@anthropic-ai/sandbox-runtime`。 */
  deps?: WinSandboxDeps;
}

async function loadSrtDeps(): Promise<WinSandboxDeps> {
  const srt = await import("@anthropic-ai/sandbox-runtime");
  return {
    resolveSrtWin: srt.resolveSrtWin,
    installWindowsSandboxAsync: srt.installWindowsSandboxAsync,
    uninstallWindowsSandbox: srt.uninstallWindowsSandbox,
    checkWindowsSandboxStatusAsync: srt.checkWindowsSandboxStatusAsync,
  };
}

/**
 * 执行 Windows 沙箱设施命令。
 *
 * - install：`installWindowsSandboxAsync`（一次 UAC；安装器已提权故内联完成）。
 *   用户取消 UAC 时 srt 返回 `{cancelled:true}` 而**不抛**——记 `ok:false` 并在 detail
 *   显式标 cancelled，否则安装器日志会写 `windows-install exit=0` 掩盖「其实没装」。
 * - uninstall：`uninstallWindowsSandbox`（清账户/WFP/ACE），cancel 语义同上。
 * - status：`checkWindowsSandboxStatusAsync`——就绪判定读结构化字段
 *   `user.provisioned` + `wfp.state`（srt 的 `WindowsSandboxStatus` 顶层**没有**
 *   `installed` 字段；旧实现用 `as` 断言读 `.installed` 恒 undefined → 恒报未就绪）。
 *
 * 任一 srt 调用抛错都被吞成 `{ ok:false }` + 原因，绝不 throw（安装器不能因此崩）。
 */
export async function runWindowsSandboxSetup(
  action: WinSandboxAction,
  opts: WinSandboxSetupOptions = {},
): Promise<WinSandboxSetupResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: false, skipped: true, detail: `no-op on ${platform} (Windows-only sandbox facility)` };
  }
  try {
    const deps = opts.deps ?? (await loadSrtDeps());
    const srtWin = deps.resolveSrtWin({ path: srtWinPath() });
    switch (action) {
      case "install": {
        const r = await deps.installWindowsSandboxAsync({ srtWin });
        return r.cancelled
          ? { ok: false, skipped: false, detail: "cancelled: UAC dismissed (sandbox not installed)" }
          : { ok: true, skipped: false, detail: `installed: ${safeJson(r)}` };
      }
      case "uninstall": {
        const r = deps.uninstallWindowsSandbox({ srtWin });
        return r.cancelled
          ? { ok: false, skipped: false, detail: "cancelled: UAC dismissed (sandbox not uninstalled)" }
          : { ok: true, skipped: false, detail: `uninstalled: ${safeJson(r)}` };
      }
      case "status": {
        const r = await deps.checkWindowsSandboxStatusAsync({ srtWin });
        // 就绪 = srt-sandbox 账户已建（`user.provisioned`，不需提权即可读）且 WFP 围栏
        // 未被**确证**缺失。`wfp.state ∈ 'installed' | 'absent' | 'cannot-read'`：BFE 枚举
        // 需提权，非提权 doctor 自检只拿得到 'cannot-read'（读不到、非错误，见 srt 注释）。
        // 故只把 'absent'（确证无围栏）判为未就绪；'cannot-read'（无法证伪）不因此判负——
        // 否则非提权自检会恒报未就绪，正是本命令要避免的假阴性（对齐 cli.ts「供 doctor/
        // 自检读」的意图）。真机提权路径下 state 会是 'installed'，判定收紧无碍。
        const ready = Boolean(r?.user?.provisioned) && r?.wfp?.state !== "absent";
        return { ok: ready, skipped: false, detail: `status: ${safeJson(r)}` };
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
