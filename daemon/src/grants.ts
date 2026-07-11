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

export function listGrants(path = paths.grantsPath): GrantRecord[] {
  return Object.values(read(path).grants);
}

export function revokeGrant(key: string, path = paths.grantsPath): boolean {
  const g = read(path);
  if (!(key in g.grants)) return false;
  delete g.grants[key];
  write(g, path);
  return true;
}
