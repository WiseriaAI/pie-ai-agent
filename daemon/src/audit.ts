import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";
import type { AuditEntry } from "../../src/types/local-bridge";

// wire 类型单一权威源在 src/types/local-bridge.ts；此处 re-export 保住既有 import 方
// （如 skill-exec.ts）不用改 import 路径。
export type { AuditEntry };

// best-effort：审计失败绝不阻断执行（spec §安全模型 audit = 知情权，非闸）。
export function appendAudit(entry: AuditEntry, path = paths.auditPath): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    /* swallow */
  }
}

export function readAuditTail(limit = 20, path = paths.auditPath): AuditEntry[] {
  // ponytail: 全量读文件解析取尾——一行一条,v1 量级 MB 内;文件真大了再改 seek 尾块。
  // 先解析全量再切尾（而非先切尾再解析）：否则尾部混进坏行会把合法条目挤出窗口。
  const n = Math.max(1, Math.min(limit, 200));
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const parsed: AuditEntry[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* 坏行跳过 */
      }
    }
    return parsed.slice(-n).reverse(); // 新的在前
  } catch {
    return [];
  }
}
