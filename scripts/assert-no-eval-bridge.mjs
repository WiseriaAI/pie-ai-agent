#!/usr/bin/env node
// Build-time invariant: 生产 dist/ 绝不能含 eval bridge 痕迹。
// 仿 tool-names.ts / tools.ts 的「构建期不变量」文化:违反即非零退出,CI fail。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const NEEDLES = ["__pieEval", "mountEvalBridge", "eval-bridge"];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const hits = [];
for (const file of walk(DIST)) {
  if (!/\.(js|html|map)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const needle of NEEDLES) if (text.includes(needle)) hits.push(`${file} :: ${needle}`);
}

if (hits.length) {
  console.error("✗ eval bridge leaked into production dist/:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("✓ no eval bridge in production dist/");
