import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdtempSync } from "fs";
import {
  permsHash,
  grantKey,
  hasGrant,
  putGrant,
  listGrants,
  revokeGrant,
  type ScriptPerms,
} from "../src/grants";

function tmpGrants(): string {
  const dir = mkdtempSync(join(tmpdir(), "pie-grants-"));
  return join(dir, "grants.json");
}
const FS: ScriptPerms = { fs: true, network: [] };

test("permsHash 含脚本内容：改代码即变", () => {
  const a = permsHash(FS, "export default () => 1");
  const b = permsHash(FS, "export default () => 2");
  expect(a).not.toBe(b);
  expect(a).toHaveLength(32);
});

test("permsHash 对 network 顺序不敏感（canonical 排序）", () => {
  const p1: ScriptPerms = { fs: true, network: ["b.com", "a.com"] };
  const p2: ScriptPerms = { fs: true, network: ["a.com", "b.com"] };
  expect(permsHash(p1, "x")).toBe(permsHash(p2, "x"));
});

test("hasGrant：miss → false；putGrant 后 → true；改代码后 → false", () => {
  const path = tmpGrants();
  const code = "export default () => 1";
  expect(hasGrant("s1", FS, code, path)).toBe(false);
  putGrant(
    { key: grantKey("s1", permsHash(FS, code)), skillId: "s1", entry: "scripts/a.js", perms: FS, grantedAt: 111 },
    path,
  );
  expect(hasGrant("s1", FS, code, path)).toBe(true);
  expect(hasGrant("s1", FS, "export default () => 2", path)).toBe(false); // 换代码即失效
});

test("listGrants 列出记录；revokeGrant 删除并返回是否命中", () => {
  const path = tmpGrants();
  const key = grantKey("s1", permsHash(FS, "c"));
  putGrant({ key, skillId: "s1", entry: "a.js", perms: FS, grantedAt: 1 }, path);
  expect(listGrants(path).map((g) => g.key)).toEqual([key]);
  expect(revokeGrant(key, path)).toBe(true);
  expect(listGrants(path)).toEqual([]);
  expect(revokeGrant(key, path)).toBe(false); // 已不在
});

test("坏 grants.json → 当空账本（韧性，不 throw）", () => {
  const path = tmpGrants();
  require("fs").writeFileSync(path, "{ not json");
  expect(listGrants(path)).toEqual([]);
  expect(hasGrant("s1", FS, "c", path)).toBe(false);
});
