import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// __dirname under vitest is the test file location; src root is two levels up
const SRC_ROOT = resolve(__dirname, "..", "..");

function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...walkFiles(full, ext));
    } else if (entry.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

describe("R-cdp-1: all CDP attaches route through requireCdpInput", () => {
  it("acquireCdpSession is only called by approved modules", () => {
    const tsFiles = walkFiles(SRC_ROOT, ".ts");
    const callers: string[] = [];
    for (const f of tsFiles) {
      if (f.includes("cdp-session.ts")) continue; // the function's own module
      if (f.includes(".test.")) continue; // tests are allowed to call directly
      const content = readFileSync(f, "utf-8");
      if (/acquireCdpSession\s*\(/.test(content)) {
        callers.push(f.replace(SRC_ROOT, ""));
      }
    }
    // R-cdp-1: only the agent loop's task-scoped factory and the screenshot
    // DI adapter (which wraps the same pattern for the screenshot tool) may
    // call this directly. Any other caller must instead route through
    // requireCdpInput (called by individual tool handlers) and use the
    // deps.acquireSession closure handed down from loop.ts.
    const APPROVED = [
      "/lib/agent/loop.ts",
      "/background/cdp-adapter.ts",
    ];
    const unapproved = callers.filter((c) => !APPROVED.includes(c));
    expect(unapproved, `Unapproved acquireCdpSession callers: ${unapproved.join(", ")}`).toEqual([]);
  });

  it("every CDP-using tool handler references requireCdpInput", () => {
    const files = [
      "src/lib/agent/tools/mouse.ts",
      "src/lib/agent/tools/keyboard.ts",
    ];
    for (const f of files) {
      const full = resolve(SRC_ROOT, "..", f);
      const content = readFileSync(full, "utf-8");
      expect(content, `${f} must call requireCdpInput`).toMatch(/requireCdpInput\s*\(/);
    }
  });
});
