import { test, expect } from "bun:test";
import { homedir } from "os";
import {
  AGENT_CANDIDATES,
  WINDOWS_AGENT_CANDIDATES,
  agentCandidatesFor,
  detectAgents,
  parseShellPath,
  parseWherePath,
  isWindowsAppsStub,
  parseRegQueryPath,
  mergeWindowsPath,
} from "../src/agents";

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

test("每条 terminal 候选都有 headlessArgv 且含 {prompt}（run_local_agent 多后端前提）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind !== "terminal") continue;
    expect(c.headlessArgv?.length).toBeGreaterThan(0);
    expect(c.headlessArgv?.some((a) => a.includes("{prompt}"))).toBe(true);
  }
});

test("app 候选没有 headlessArgv（app 无 CLI，不能作 headless 后端）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "app") expect(c.headlessArgv).toBeUndefined();
  }
});

test("各家 headless 契约（已查实的命令 + 跳权限 flag）", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(byId["claude-terminal"].headlessArgv).toEqual(["-p", "--dangerously-skip-permissions", "{prompt}"]);
  expect(byId["codex-terminal"].headlessArgv).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "{prompt}"]);
  expect(byId["cursor-terminal"].headlessArgv).toEqual(["-p", "--force", "{prompt}"]);
  expect(byId["opencode-terminal"].headlessArgv).toEqual(["run", "--auto", "{prompt}"]);
  expect(byId["pi-terminal"].headlessArgv).toEqual(["-p", "{prompt}"]);
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

// ---- Windows 检测适配（#364, spec §4.7）----

test("isWindowsAppsStub: WindowsApps 别名 stub 认出（正/反斜杠、大小写不敏感）", () => {
  expect(isWindowsAppsStub("C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe")).toBe(true);
  expect(isWindowsAppsStub("C:/Users/x/AppData/Local/Microsoft/windowsapps/python.exe")).toBe(true);
  expect(isWindowsAppsStub("C:\\Program Files\\nodejs\\claude.cmd")).toBe(false);
});

test("parseWherePath: 取第一个非 WindowsApps stub 的绝对路径", () => {
  const stdout =
    "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe\r\n" +
    "C:\\Program Files\\nodejs\\claude.cmd\r\n";
  expect(parseWherePath(stdout)).toBe("C:\\Program Files\\nodejs\\claude.cmd");
});

test("parseWherePath: 全是 stub → null（视为未装）", () => {
  const stdout = "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe\r\n";
  expect(parseWherePath(stdout)).toBeNull();
});

test("parseWherePath: 空输出（where exit 1，未装）→ null", () => {
  expect(parseWherePath("")).toBeNull();
  expect(parseWherePath("\r\n  \r\n")).toBeNull();
});

test("parseRegQueryPath: 从 reg query 输出取 Path 值（REG_EXPAND_SZ / REG_SZ 都认）", () => {
  const expand =
    "\r\nHKEY_CURRENT_USER\\Environment\r\n" +
    "    Path    REG_EXPAND_SZ    C:\\Users\\x\\bin;C:\\tools\r\n\r\n";
  expect(parseRegQueryPath(expand)).toBe("C:\\Users\\x\\bin;C:\\tools");
  const sz = "    Path    REG_SZ    C:\\Windows;C:\\Windows\\System32\r\n";
  expect(parseRegQueryPath(sz)).toBe("C:\\Windows;C:\\Windows\\System32");
});

test("parseRegQueryPath: 无 Path 值 → 空串", () => {
  expect(parseRegQueryPath("HKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_SZ    C:\\Temp\r\n")).toBe("");
  expect(parseRegQueryPath("")).toBe("");
});

test("mergeWindowsPath: env 打头 + 注册表补充，大小写不敏感去重", () => {
  const merged = mergeWindowsPath("C:\\Windows;C:\\proc-only", [
    "C:\\Users\\x\\bin;C:\\windows", // C:\windows 与 env 的 C:\Windows 大小写重复 → 去掉
    "C:\\tools;;  ;C:\\Users\\x\\bin", // 空段忽略；C:\Users\x\bin 已见 → 去掉
  ]);
  expect(merged).toBe("C:\\Windows;C:\\proc-only;C:\\Users\\x\\bin;C:\\tools");
});

test("mergeWindowsPath: 全空来源 → 空串", () => {
  expect(mergeWindowsPath("", ["", ""])).toBe("");
});

test("agentCandidatesFor: win32 → Windows 草案表；其余 → mac 8 条", () => {
  expect(agentCandidatesFor("win32")).toBe(WINDOWS_AGENT_CANDIDATES);
  expect(agentCandidatesFor("darwin")).toBe(AGENT_CANDIDATES);
  expect(agentCandidatesFor("linux")).toBe(AGENT_CANDIDATES);
});

test("Windows 草案表全部 verified:false（铁律：未真机验证不得默认启用）", () => {
  expect(WINDOWS_AGENT_CANDIDATES.length).toBeGreaterThan(0);
  for (const c of WINDOWS_AGENT_CANDIDATES) expect(c.verified).toBe(false);
});

test("detectAgents(win32): 默认排除未验证草案（哪怕 where 命中也不启用）", () => {
  const detected = detectAgents({
    platform: "win32",
    which: () => "C:\\Program Files\\nodejs\\claude.cmd",
    exists: () => true,
  });
  expect(detected).toEqual([]);
});

test("detectAgents(win32, includeUnverified): 纳入草案 + where 解出的绝对路径", () => {
  const detected = detectAgents({
    platform: "win32",
    includeUnverified: true,
    which: (bin) => (bin === "claude" ? "C:\\Program Files\\nodejs\\claude.cmd" : null),
    exists: () => false,
  });
  expect(detected.map((a) => a.id)).toEqual(["claude-terminal"]);
  expect(detected[0].path).toBe("C:\\Program Files\\nodejs\\claude.cmd");
});

test("detectAgents(darwin): mac 表不受 verified 过滤影响（历史条目无字段 = 已验证）", () => {
  const detected = detectAgents({
    platform: "darwin",
    which: (bin) => (bin === "claude" ? "/Users/x/.local/bin/claude" : null),
    exists: () => false,
  });
  expect(detected.map((a) => a.id)).toContain("claude-terminal");
});
