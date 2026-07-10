import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";
import type { GrantEnvelope } from "../../src/types/local-bridge";

export interface AuditEntry {
  ts: number;
  skillName: string;
  entry: string;
  envelope: GrantEnvelope;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

// best-effort：审计失败绝不阻断执行（spec §安全模型 audit = 知情权，非闸）。
export function appendAudit(entry: AuditEntry, path = paths.auditPath): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    /* swallow */
  }
}
