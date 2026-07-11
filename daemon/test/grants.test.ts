import { test, expect } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  canonicalEnvelope, grantKey, hasGrant, putGrant, listGrants, revokeGrant,
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
