import { DAEMON_VERSION } from "./version";
import type { StatusResult } from "../../src/types/local-bridge";

// 进程模块态：daemon 单进程常驻，状态随进程生命周期存在。
const startedAtMs = Date.now();
const extSockets = new Set<unknown>();
const running = new Map<string, { name: string; entry: string; startedAt: number }>();

/** socket 层：某连接发过 hello（= 扩展 host） → 记为扩展连接。 */
export function markExtensionSocket(s: unknown): void {
  extSockets.add(s);
}
/** socket 关闭 → 移除（顶栏 app 从未 mark，无害）。 */
export function dropSocket(s: unknown): void {
  extSockets.delete(s);
}
/** skill 脚本开跑 → 登记，返回 runId。 */
export function beginSkillRun(name: string, entry: string): string {
  const id = crypto.randomUUID();
  running.set(id, { name, entry, startedAt: Date.now() });
  return id;
}
/** skill 脚本结束（finally 里调，幂等）。 */
export function endSkillRun(id: string): void {
  running.delete(id);
}
export function getStatus(): StatusResult {
  return {
    version: DAEMON_VERSION,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
    extensionConnected: extSockets.size > 0,
    runningSkills: [...running.values()].map((r) => ({ name: r.name, startedAt: r.startedAt })),
  };
}
