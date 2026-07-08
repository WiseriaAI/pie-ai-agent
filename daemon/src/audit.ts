import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";

export interface AuditEntry {
  ts: number;
  skillId: string;
  entry: string;
  perms: unknown;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

// best-effort：审计失败绝不阻断执行（spec §6.3 audit = 知情权，非闸）。
export function appendAudit(entry: AuditEntry, path = paths.auditPath): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    /* swallow */
  }
}
