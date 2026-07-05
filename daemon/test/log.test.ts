import { test, expect } from "bun:test";
import { rotateIfNeeded } from "../src/log";
import { writeFileSync, existsSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// hermetic：全在 temp 目录，不碰真实 ~/.pie/logs。

test("rotateIfNeeded: 未超限时不动", () => {
  const dir = mkdtempSync(join(tmpdir(), "pie-log-"));
  const f = join(dir, "daemon.log");
  writeFileSync(f, "small");
  rotateIfNeeded(f, 1000, 3);
  expect(existsSync(f)).toBe(true); // 原样
  expect(existsSync(`${f}.1`)).toBe(false);
});

test("rotateIfNeeded: 超限轮转、封顶 KEEP、逐出最旧", () => {
  const dir = mkdtempSync(join(tmpdir(), "pie-log-"));
  const f = join(dir, "daemon.log");
  const big = "x".repeat(200);

  writeFileSync(f, big); // round 1
  rotateIfNeeded(f, 100, 3);
  expect(existsSync(`${f}.1`)).toBe(true); // daemon.log → .1
  expect(existsSync(f)).toBe(false); // 下次写才建新

  writeFileSync(f, big); // round 2
  rotateIfNeeded(f, 100, 3);
  expect(existsSync(`${f}.2`)).toBe(true); // 旧 .1 → .2

  writeFileSync(f, "R3" + big); // round 3
  rotateIfNeeded(f, 100, 3);
  expect(existsSync(`${f}.3`)).toBe(false); // 永不超过 KEEP（最旧被逐出）
});

test("rotateIfNeeded: 缺文件不抛", () => {
  const dir = mkdtempSync(join(tmpdir(), "pie-log-"));
  expect(() => rotateIfNeeded(join(dir, "nope.log"), 100, 3)).not.toThrow();
});
