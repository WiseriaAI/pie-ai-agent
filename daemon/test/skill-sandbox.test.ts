import { test, expect } from "bun:test";
import { fakeSkillSandbox } from "../src/skill-sandbox";
import type { SandboxSettings } from "../src/skill-sandbox";

// 只测接口契约 + fakeSkillSandbox。真 OS 强制（写限/敏感读拒/断网/按域名放行）走
// 真机清单（scratch-skill-sandbox-realmachine.ts / spike 决策记录），CI 碰不到 sandbox-exec。

test("fakeSkillSandbox forwards args to impl and returns its result", async () => {
  const seen: { argv: string[]; cwd: string; env: Record<string, string>; settings: SandboxSettings }[] = [];
  const sb = fakeSkillSandbox(async (argv, cwd, env, settings) => {
    seen.push({ argv, cwd, env, settings });
    return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  const r = await sb.run(
    ["node", "x.js"],
    "/tmp/skill",
    { A: "1" },
    { allowWrite: ["/tmp/skill/workspace"], allowedDomains: [], denyRead: ["/Users/me/.ssh"] },
  );
  expect(r.stdout).toBe("ok");
  expect(r.exitCode).toBe(0);
  expect(seen).toHaveLength(1);
  expect(seen[0].argv).toEqual(["node", "x.js"]);
  expect(seen[0].cwd).toBe("/tmp/skill");
  expect(seen[0].settings.allowWrite).toEqual(["/tmp/skill/workspace"]);
});
