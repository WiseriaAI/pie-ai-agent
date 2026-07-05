import { appendFileSync, statSync, renameSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { paths } from "./paths";

const LOG_FILE = join(paths.logsDir, "daemon.log");
const MAX_BYTES = 5 * 1024 * 1024; // 单文件 5MB
const KEEP = 3; // daemon.log + .1 + .2 → 总量 ≤15MB，最旧的被逐出

/**
 * 按大小轮转（逐出最旧、总量封顶）。**无 timer/cron**——轮转搭在写操作上，
 * resident daemon 里这是最省的做法。对入参纯函数，故可对 temp 目录 hermetic 单测。
 * 永不抛（日志不能拖垮 daemon）。
 *
 * keep=3 时：写超限 → .1→.2（覆盖旧 .2 = 逐出）、daemon.log→.1、下次写建新 daemon.log。
 */
export function rotateIfNeeded(logFile: string, maxBytes: number, keep: number): void {
  try {
    if (!existsSync(logFile) || statSync(logFile).size < maxBytes) return;
    for (let i = keep - 1; i >= 1; i--) {
      const src = i === 1 ? logFile : `${logFile}.${i - 1}`;
      if (existsSync(src)) renameSync(src, `${logFile}.${i}`);
    }
  } catch {
    /* 日志绝不抛 */
  }
}

type Level = "info" | "warn" | "error";

// 单测里关掉：handleMessage / runLocalAgent 会调 log，默认会写真实 ~/.pie/logs
// （虽然 log 吞错不会让 CI 挂，但污染真实日志）。测试 setLogEnabled(false) 即 hermetic。
let enabled = true;
export function setLogEnabled(v: boolean): void {
  enabled = v;
}

/**
 * 往 ~/.pie/logs/daemon.log 追加一行带时间戳的 JSON（同时 console.error 一份，
 * 让 launchd StandardErrorPath 与前台运行都能看到）。
 * 只记元数据（长度/退出码/cwd），**不记 prompt/output 原文**（untrusted + 可能敏感）。
 */
export function log(level: Level, event: string, fields?: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    if (!existsSync(paths.logsDir)) mkdirSync(paths.logsDir, { recursive: true });
    rotateIfNeeded(LOG_FILE, MAX_BYTES, KEEP);
    const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
    appendFileSync(LOG_FILE, line + "\n");
    console.error(line);
  } catch {
    /* 日志绝不抛 */
  }
}
