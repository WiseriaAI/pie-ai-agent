import { test, expect } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  canonicalEnvelope, grantKey, hasGrant, putGrant, listGrants, revokeGrant, sweepGrants,
} from "../src/grants";
import type { GrantEnvelope } from "../../src/types/local-bridge";

function tmpPath(): string {
  const dir = join(import.meta.dir, ".tmp-grants-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return join(dir, "grants.json");
}
const ENV: GrantEnvelope = { allowedDomains: ["b.com", "a.com"], extraWrites: ["~/out"], runnableScripts: ["y.ts", "x.ts"] };

test("canonicalEnvelope sorts+dedups so key is order-insensitive", () => {
  const k1 = grantKey("s", { allowedDomains: ["a.com", "b.com"], extraWrites: ["~/out"], runnableScripts: ["x.ts", "y.ts"] });
  const k2 = grantKey("s", ENV);
  expect(k1).toBe(k2);
});

test("put/has/list/revoke round-trip", () => {
  const p = tmpPath();
  expect(hasGrant("s", ENV, p)).toBe(false);
  const key = grantKey("s", ENV);
  putGrant({ key, skillName: "s", envelope: canonicalEnvelope(ENV), grantedAt: 1 }, p);
  expect(hasGrant("s", ENV, p)).toBe(true);
  expect(listGrants(p).map((g) => g.skillName)).toEqual(["s"]);
  expect(revokeGrant(key, p)).toBe(true);
  expect(hasGrant("s", ENV, p)).toBe(false);
  expect(revokeGrant(key, p)).toBe(false);
  rmSync(p, { force: true });
});

test("envelope change (added domain) → different key → re-prompt", () => {
  const wider: GrantEnvelope = { ...ENV, allowedDomains: [...ENV.allowedDomains, "c.com"] };
  expect(grantKey("s", wider)).not.toBe(grantKey("s", ENV));
});

test("listGrants filters legacy 2b-format records (skillId/perms, no envelope) that violate the wire type", () => {
  const p = tmpPath();
  const key = grantKey("s", ENV);
  putGrant({ key, skillName: "s", envelope: canonicalEnvelope(ENV), grantedAt: 1 }, p);
  // 真机 grants.json 里的 2b 旧格式残留（skillId/entry/perms，无 envelope）——
  // 设置页渲染 g.envelope.runnableScripts 会整页 crash（真机 A3 验收案例）
  const raw = JSON.parse(readFileSync(p, "utf8"));
  raw.grants["skill:legacy:deadbeef"] = {
    key: "skill:legacy:deadbeef",
    skillId: "legacy",
    entry: "scripts/save.js",
    perms: { fs: true, network: [] },
    grantedAt: 2,
  };
  writeFileSync(p, JSON.stringify(raw));
  const grants = listGrants(p);
  expect(grants).toHaveLength(1); // toEqual 会忽略 undefined 元素,必须断长度
  expect(grants[0].skillName).toBe("s");
  rmSync(p, { force: true });
});

test("sweepGrants drops legacy records, bumps version=2, and is byte-stable on re-run", () => {
  const p = tmpPath();
  const key = grantKey("s", ENV);
  putGrant({ key, skillName: "s", envelope: canonicalEnvelope(ENV), grantedAt: 1 }, p);
  // 注入一条 2b 旧格式死记录（skillId/perms，无 envelope）
  const raw = JSON.parse(readFileSync(p, "utf8"));
  raw.grants["skill:legacy:deadbeef"] = {
    key: "skill:legacy:deadbeef", skillId: "legacy", entry: "scripts/save.js",
    perms: { fs: true, network: [] }, grantedAt: 2,
  };
  writeFileSync(p, JSON.stringify(raw));

  sweepGrants(p);
  const after = JSON.parse(readFileSync(p, "utf8"));
  expect(after.version).toBe(2);
  expect(Object.keys(after.grants)).toEqual([key]); // 只剩契约合规记录
  expect(after.grants[key].skillName).toBe("s");

  // 幂等：再扫一次字节级稳定
  const bytes1 = readFileSync(p, "utf8");
  sweepGrants(p);
  expect(readFileSync(p, "utf8")).toBe(bytes1);
  rmSync(p, { force: true });
});

test("sweepGrants on a pure-legacy file yields an empty version=2 ledger", () => {
  const p = tmpPath();
  writeFileSync(p, JSON.stringify({
    version: 1,
    grants: {
      "skill:a:1": { key: "skill:a:1", skillId: "a", perms: {}, grantedAt: 1 },
      "skill:b:2": { key: "skill:b:2", skillId: "b", perms: {}, grantedAt: 2 },
    },
  }));
  sweepGrants(p);
  const after = JSON.parse(readFileSync(p, "utf8"));
  expect(after).toEqual({ version: 2, grants: {} });
  rmSync(p, { force: true });
});

test("sweepGrants leaves new-format records byte-for-byte untouched when already clean", () => {
  const p = tmpPath();
  const key = grantKey("s", ENV);
  putGrant({ key, skillName: "s", envelope: canonicalEnvelope(ENV), grantedAt: 1 }, p);
  sweepGrants(p); // 首扫把 version 提到 2
  const bytes = readFileSync(p, "utf8");
  expect(JSON.parse(bytes).version).toBe(2);
  sweepGrants(p); // 再扫不动
  expect(readFileSync(p, "utf8")).toBe(bytes);
  rmSync(p, { force: true });
});

test("sweepGrants is a no-op on a missing file (does not create it)", () => {
  const p = tmpPath();
  rmSync(p, { force: true });
  sweepGrants(p);
  expect(existsSync(p)).toBe(false);
});

test("sweepGrants leaves a corrupt-JSON file untouched (read-time resilience keeps ledger empty)", () => {
  const p = tmpPath();
  writeFileSync(p, "{ not valid json ]");
  sweepGrants(p);
  expect(readFileSync(p, "utf8")).toBe("{ not valid json ]"); // 文件不动
  expect(listGrants(p)).toEqual([]); // 读时当空账本
  rmSync(p, { force: true });
});
