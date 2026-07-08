import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import { paths } from "./paths";

export interface ScriptPerms {
  fs: boolean;
  network: string[];
}
export interface GrantRecord {
  key: string;
  skillId: string;
  entry: string;
  perms: ScriptPerms;
  grantedAt: number;
}
interface GrantsFile {
  version: number;
  grants: Record<string, GrantRecord>;
}

// permsHash = sha256(canonical(perms) + "\n" + code) 前 32 hex。含脚本内容：
// agent-authored skill 改脚本代码即 hash 变 → grant 自动失效重弹卡（spec §6.1）。
export function permsHash(perms: ScriptPerms, code: string): string {
  const canon = JSON.stringify({ fs: perms.fs, network: [...perms.network].sort() });
  return createHash("sha256").update(canon + "\n" + code).digest("hex").slice(0, 32);
}

export function grantKey(skillId: string, hash: string): string {
  return `skill:${skillId}:${hash}`;
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

export function hasGrant(
  skillId: string,
  perms: ScriptPerms,
  code: string,
  path = paths.grantsPath,
): boolean {
  return grantKey(skillId, permsHash(perms, code)) in read(path).grants;
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
