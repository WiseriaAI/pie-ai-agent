import { test, expect } from "bun:test";
import { homedir } from "os";
import { AGENT_CANDIDATES, detectAgents, parseShellPath } from "../src/agents";

test("parseShellPath: takes the last line (rc 噪音在前面)", () => {
  const stdout = "Last login: whatever\n/usr/bin:/opt/homebrew/bin\n";
  expect(parseShellPath(stdout, "/fallback")).toBe("/usr/bin:/opt/homebrew/bin");
});

test("parseShellPath: 空输出（shell 挂了/超时）回落 fallback", () => {
  expect(parseShellPath("", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  expect(parseShellPath("   \n  \n", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
});

test("parseShellPath: 单行正常输出", () => {
  expect(parseShellPath("/a:/b\n", "/fallback")).toBe("/a:/b");
});

test("候选表 8 条，品牌分组、每组 app 在前（= HandoffCard 预选顺序）", () => {
  expect(AGENT_CANDIDATES.map((c) => c.id)).toEqual([
    "claude-app", "claude-terminal",
    "codex-app", "codex-terminal",
    "cursor-app", "cursor-terminal",
    "opencode-terminal", "pi-terminal",
  ]);
});

test("候选表字段齐备：terminal 有 bin，app 有 appPaths", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "terminal") expect(c.bin).toBeDefined();
    else expect(c.appPaths?.length).toBeGreaterThan(0);
  }
});

test("terminal 候选的 argv 必须含 {prompt} 占位（否则交棒开不了跑）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind !== "terminal") continue;
    expect(c.argv?.some((a) => a.includes("{prompt}"))).toBe(true);
  }
});

test("app 候选必须有 convention（无 prompt 注入面，只能靠引导文件）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "app") expect(c.convention).toBeDefined();
  }
});

test("opencode 走 --prompt flag，其余 terminal 走位置参数", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(byId["opencode-terminal"].argv).toEqual(["--prompt", "{prompt}"]);
  expect(byId["claude-terminal"].argv).toEqual(["{prompt}"]);
  // 产品拍板（2026-07-14 验收）：交棒到手即跑，代价 = 该 codex 会话无审批无沙箱
  expect(byId["codex-terminal"].argv).toEqual(["--dangerously-bypass-approvals-and-sandbox", "{prompt}"]);
  // 不带 --trust：真机实测交互式 TUI 下报 "--trust can only be used with --print/headless mode"
  expect(byId["cursor-terminal"].argv).toEqual(["{prompt}"]);
  expect(byId["pi-terminal"].argv).toEqual(["{prompt}"]);
  expect(byId["cursor-terminal"].bin).toBe("cursor-agent"); // 注意：不是 "cursor"（那是 IDE 启动器）
});

test("detectAgents 带出绝对路径（terminal = which 解出的，app = 命中的 bundle 路径）", () => {
  const detected = detectAgents({
    which: (bin) => (bin === "codex" ? "/Users/x/.local/bin/codex" : null),
    exists: (p) => p === "/Applications/Claude.app",
  });
  expect(detected.map((a) => a.id)).toEqual(["claude-app", "codex-terminal"]);
  expect(detected.find((a) => a.id === "codex-terminal")!.path).toBe("/Users/x/.local/bin/codex");
  expect(detected.find((a) => a.id === "claude-app")!.path).toBe("/Applications/Claude.app");
});

test("detectAgents returns empty when nothing installed", () => {
  expect(detectAgents({ which: () => null, exists: () => false })).toEqual([]);
});

test("app 候选按 appPaths 优先级探，命中第一个存在的", () => {
  // 只装了 ChatGPT.app（Codex 与 ChatGPT 合并后的常态）
  const detected = detectAgents({
    which: () => null,
    exists: (p) => p === "/Applications/ChatGPT.app",
  });
  const codexApp = detected.find((a) => a.id === "codex-app");
  expect(codexApp?.path).toBe("/Applications/ChatGPT.app");
});

test("两个 app 路径都在时，取表里排第一的", () => {
  const detected = detectAgents({
    which: () => null,
    exists: (p) => p === "/Applications/Codex.app" || p === "/Applications/ChatGPT.app",
  });
  expect(detected.find((a) => a.id === "codex-app")?.path).toBe("/Applications/Codex.app");
});

test("terminal 候选 PATH 找不到时回落 binPaths 知名安装路径（常规安装但 rc 没配 PATH）", () => {
  const home = homedir();
  const detected = detectAgents({
    which: () => null,
    exists: (p) => p === `${home}/.opencode/bin/opencode`,
  });
  const oc = detected.find((a) => a.id === "opencode-terminal");
  expect(oc?.path).toBe(`${home}/.opencode/bin/opencode`);
});

test("PATH 命中优先于 binPaths 回落（用户自装位置说了算）", () => {
  const detected = detectAgents({
    which: (bin) => (bin === "opencode" ? "/custom/bin/opencode" : null),
    exists: () => true,
  });
  expect(detected.find((a) => a.id === "opencode-terminal")?.path).toBe("/custom/bin/opencode");
});
