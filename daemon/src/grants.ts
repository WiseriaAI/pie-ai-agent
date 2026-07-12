import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";
import type { GrantEnvelope, GrantRecord } from "../../src/types/local-bridge";

interface GrantsFile {
  version: number;
  grants: Record<string, GrantRecord>;
}

function uniqSort(a: string[]): string[] {
  return [...new Set(a)].sort();
}

/** 排序去重三字段——信封身份与声明顺序无关。 */
export function canonicalEnvelope(e: GrantEnvelope): GrantEnvelope {
  return {
    allowedDomains: uniqSort(e.allowedDomains),
    extraWrites: uniqSort(e.extraWrites),
    runnableScripts: uniqSort(e.runnableScripts),
  };
}

export function envelopeHash(e: GrantEnvelope): string {
  return createHash("sha256").update(JSON.stringify(canonicalEnvelope(e))).digest("hex").slice(0, 32);
}

export function grantKey(skillName: string, e: GrantEnvelope): string {
  return `skill:${skillName}:${envelopeHash(e)}`;
}

function read(path: string): GrantsFile {
  if (!existsSync(path)) return { version: 1, grants: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GrantsFile;
    return parsed && typeof parsed === "object" && parsed.grants ? parsed : { version: 1, grants: {} };
  } catch {
    return { version: 1, grants: {} }; // 坏文件当空账本（韧性）
  }
}

function write(g: GrantsFile, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(g, null, 2));
  renameSync(tmp, path); // 原子替换
}

export function hasGrant(skillName: string, e: GrantEnvelope, path = paths.grantsPath): boolean {
  return grantKey(skillName, e) in read(path).grants;
}

export function putGrant(record: GrantRecord, path = paths.grantsPath): void {
  const g = read(path);
  g.grants[record.key] = record;
  write(g, path);
}

/**
 * GrantRecord 契约谓词——2b 旧格式残留（skillId/perms，无 envelope）不符合 wire
 * 类型：设置页渲染 g.envelope.* 会整页 crash（真机 A3 验收案例）。listGrants 读时过滤
 * 与 sweepGrants 启动清扫共用这一份判据。
 */
export function isValidGrantRecord(g: unknown): g is GrantRecord {
  if (g == null || typeof g !== "object") return false;
  const r = g as Partial<GrantRecord>;
  return typeof r.skillName === "string" && r.envelope != null && Array.isArray(r.envelope.runnableScripts);
}

export function listGrants(path = paths.grantsPath): GrantRecord[] {
  // 旧记录是死数据（新 grantKey 是 envelopeHash，永远命不中旧 permsHash 键），
  // 从 list 输出滤掉（纵深防御，即便 sweep 已清）。
  return Object.values(read(path).grants).filter(isValidGrantRecord);
}

/**
 * 启动一次性幂等清扫：把 grants 账本里不符合 GrantRecord 契约的死记录（2b 旧格式）
 * 剔除、version 升到 2、原子替换落盘。审计视角保持账本干净——避免 UI 永远列不出、
 * 也就撤销不掉的幽灵条目。
 * - 文件不存在：no-op（不创建空账本）。
 * - 坏 JSON / 非账本对象：不动文件（读时韧性逻辑仍当空账本处理）。
 * - 已合规则字节级稳定不重写（幂等 + 省一次盘写）。
 */
export function sweepGrants(path = paths.grantsPath): void {
  if (!existsSync(path)) return;
  const original = readFileSync(path, "utf8");
  let parsed: GrantsFile;
  try {
    const p = JSON.parse(original) as GrantsFile;
    if (!p || typeof p !== "object" || !p.grants) return; // 非账本：读时韧性处理，文件不动
    parsed = p;
  } catch {
    return; // 坏 JSON：不动文件
  }
  const cleaned: GrantsFile = { version: 2, grants: {} };
  for (const [k, v] of Object.entries(parsed.grants)) {
    if (isValidGrantRecord(v)) cleaned.grants[k] = v;
  }
  const next = JSON.stringify(cleaned, null, 2);
  if (next !== original) write(cleaned, path);
}

export function revokeGrant(key: string, path = paths.grantsPath): boolean {
  const g = read(path);
  if (!(key in g.grants)) return false;
  delete g.grants[key];
  write(g, path);
  return true;
}
