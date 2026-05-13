import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * iframe spec R-iframe-5 grep guard.
 *
 * Behavior-level regression for cross-origin frame info NOT triggering
 * confirm paths is already covered by multi-frame snapshot tests — those
 * tests mock LLM clicking inside a cross-origin frame and assert tool result
 * success, which is structurally impossible if a confirm-request emit ever
 * blocks the loop.
 *
 * This test is the SECONDARY guard: even if a future patch reintroduces a
 * confirm helper, this grep fails. The forbidden tokens are the three
 * load-bearing names from the deleted risk.ts / confirm route.
 */
describe("R-iframe-5: confirm 层不复活的 grep guard", () => {
  it("classifyRisk / RiskClassifyContext / pendingConfirmations have ZERO callers in src/", () => {
    const SRC_ROOT = resolve(process.cwd(), "src");

    function walk(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          out.push(...walk(full));
        } else if (
          (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
          !full.endsWith("no-confirm-resurrected.test.ts")
        ) {
          out.push(full);
        }
      }
      return out;
    }

    const FORBIDDEN = ["classifyRisk", "RiskClassifyContext", "pendingConfirmations"];
    const EXCLUDE_FILES = [
      "no-confirm-resurrected.test.ts",
      "no-confirm-emit.test.ts",
    ];
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (EXCLUDE_FILES.some((f) => file.endsWith(f))) continue;
      const content = readFileSync(file, "utf8");
      // Strip comments — single-line // comments and block /* */ comments
      const stripped = content
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      for (const t of FORBIDDEN) {
        if (stripped.includes(t)) offenders.push(`${file}: ${t}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
