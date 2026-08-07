import { spawn } from "node:child_process";
import type { Socket } from "bun";
import { log } from "./log";

// host 兜底拉起：Windows 无 launchd KeepAlive，host 连不上 daemon 时自己把 daemon
// 拉起来再按退避梯子重连，补上崩溃自愈缺口（spec 2026-08-05-daemon-windows-support §4.4）。

/**
 * 退避梯子——语义对齐扩展侧 `src/background/local-bridge.ts` 的 RECONNECT_DELAYS_MS
 * （1s→2s→5s→15s→30s）。两处都是「桥断了往回连」的同一件事，梯子刻意保持一致。
 */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/** 第 attempt 次重连的等待毫秒（越界钳到梯子末端 30s）。 */
export function reconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1)]!;
}

/**
 * detached + 无窗口方式 spawn `pie.exe daemon`：父进程（host）退出不连带 daemon。
 * - detached：子进程自成进程组，父退出不牵连（Windows 下 = 新 process group）。
 * - windowsHide：隐藏控制台窗口——Bun 编译产物是 console 子系统，不加会闪 cmd 窗。
 * - stdio ignore：绝不继承 host 的 stdin/stdout（那是 Chrome native messaging 管道，
 *   一旦被 daemon 子进程沾上就会污染扩展↔host 的帧流）。
 * - unref：host 事件循环不被这个句柄卡住。
 *
 * 真机窗口/detach 行为走 need-human-test 验收（spec §6 开放问题 2：Bun 编译产物无窗口
 * 后台化的正确姿势需实测，不行则由托盘 exe 代启）。
 */
export function spawnDetachedDaemon(exePath: string = process.execPath): void {
  const child = spawn(exePath, ["daemon"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
}

export interface BootstrapOptions {
  /** 建连一次：成功 resolve Socket，连不上 reject。 */
  connect: () => Promise<Socket>;
  /** 连不上时拉起 daemon（默认 spawnDetachedDaemon；测试注入 fake）。 */
  spawnDaemon?: () => void;
  /** 退避等待（默认 setTimeout；测试注入即时/记录版）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 退避梯子（默认 RECONNECT_DELAYS_MS；测试可缩短）。 */
  delays?: number[];
}

/**
 * host 兜底拉起主循环：先尝试连 daemon；连不上 → 拉起 daemon（**只拉一次**，多余的
 * 靠单实例互斥挡掉）→ 按退避梯子重连，直到连上或梯子走完。走完仍连不上则把最后一次
 * 的错误抛出，让 host 退出、交给扩展侧下一轮重连再拉一个新 host（与 mac「连不上即退出」
 * 的最终语义一致，Windows 这里只是多了一层自愈）。
 */
export async function connectWithBootstrap(opts: BootstrapOptions): Promise<Socket> {
  const spawnDaemon = opts.spawnDaemon ?? spawnDetachedDaemon;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const delays = opts.delays ?? RECONNECT_DELAYS_MS;
  let spawned = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await opts.connect();
    } catch (err) {
      if (attempt >= delays.length) throw err; // 梯子走完仍连不上 → 交给上层退出
      if (!spawned) {
        log("info", "host.bootstrap_daemon", { reason: String(err) });
        spawnDaemon();
        spawned = true;
      }
      await sleep(delays[Math.min(attempt, delays.length - 1)]!);
    }
  }
}

/**
 * daemon 单实例互斥判定：Windows named pipe 名被占用时 `Bun.listen` 抛 EADDRINUSE
 * ——「抢 pipe，占用即退出」的信号。predicate 抽出来是为了可测（真实 named pipe
 * 冲突只在 Windows 真机复现），覆盖 code / errno / message 多种形态。
 */
export function isAddrInUseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (e.code === "EADDRINUSE") return true;
  if (typeof e.errno === "string" && e.errno === "EADDRINUSE") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return /EADDRINUSE|address (already )?in use|already in use/i.test(msg);
}
