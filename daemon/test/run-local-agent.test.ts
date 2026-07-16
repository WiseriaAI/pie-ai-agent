import { test, expect } from "bun:test";
import { runLocalAgent } from "../src/run-local-agent";
import { AGENT_CANDIDATES, type DetectedAgent } from "../src/agents";
import { setLogEnabled } from "../src/log";

setLogEnabled(false); // hermetic：不让 runLocalAgent 的 log 写真实 ~/.pie/logs

/** 从候选表按 id 取一条 + 挂上假的绝对 path，构造 detect() 的返回项。 */
function detected(id: DetectedAgent["id"], path: string): DetectedAgent {
  const c = AGENT_CANDIDATES.find((x) => x.id === id);
  if (!c) throw new Error(`no such candidate: ${id}`);
  return { ...c, path };
}

test("spawns first installed headless agent with detected absolute path", async () => {
  let seen: { cmd: string; args: string[] } | null = null;
  const fakeSpawn = async (cmd: string, args: string[], _cwd: string) => {
    seen = { cmd, args };
    return { stdout: "AGENT REPLY", exitCode: 0 };
  };
  const ensureDirCalls: string[] = [];
  const fakeEnsureDir = (dir: string) => {
    ensureDirCalls.push(dir);
  };
  const r = await runLocalAgent(
    { target: "claude", prompt: "hello world" },
    {
      spawn: fakeSpawn,
      ensureDir: fakeEnsureDir,
      detect: () => [detected("claude-terminal", "/abs/bin/claude")],
    },
  );
  expect(r.output).toBe("AGENT REPLY");
  expect(r.exitCode).toBe(0);
  expect(r.cwd).toContain("pie-handoffs"); // 默认临时 workspace
  // spawn 用检测到的绝对路径，不是裸 "claude"（裸命令名在 launchd 裸 PATH 下会 not found）
  expect(seen!.cmd).toBe("/abs/bin/claude");
  expect(seen!.args).toContain("-p");
  expect(seen!.args).toContain("--dangerously-skip-permissions");
  expect(seen!.args).toContain("hello world");
  // 证明 workspace 创建走注入的 ensureDir，而非真实文件系统 I/O
  expect(ensureDirCalls).toHaveLength(1);
  expect(ensureDirCalls[0]).toContain("pie-handoffs");
  // 后端回填给卡片/observation
  expect(r.backend).toEqual({ id: "claude-terminal", label: "Claude Code (Terminal)" });
});

test("picks first candidate in table order when several are installed (claude wins)", async () => {
  let seenCmd = "";
  const fakeSpawn = async (cmd: string) => {
    seenCmd = cmd;
    return { stdout: "ok", exitCode: 0 };
  };
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    {
      spawn: fakeSpawn,
      ensureDir: () => {},
      // detect 保表顺序：claude 在 codex/pi 之前
      detect: () => [
        detected("claude-terminal", "/abs/claude"),
        detected("codex-terminal", "/abs/codex"),
        detected("pi-terminal", "/abs/pi"),
      ],
    },
  );
  expect(seenCmd).toBe("/abs/claude");
  expect(r.backend!.id).toBe("claude-terminal");
});

test("no target + no claude installed: defaults to the next headless backend in table order (codex)", async () => {
  let seen: { cmd: string; args: string[] } | null = null;
  const fakeSpawn = async (cmd: string, args: string[]) => {
    seen = { cmd, args };
    return { stdout: "codex reply", exitCode: 0 };
  };
  const r = await runLocalAgent(
    { prompt: "do a thing" }, // target 缺省 → 表顺序第一个已装 headless
    {
      spawn: fakeSpawn,
      ensureDir: () => {},
      detect: () => [detected("codex-terminal", "/abs/codex")],
    },
  );
  expect(seen!.cmd).toBe("/abs/codex");
  expect(seen!.args).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "do a thing"]);
  expect(r.output).toBe("codex reply");
  expect(r.backend!.id).toBe("codex-terminal");
});

test("explicit target picks that backend even when it is not first in table order", async () => {
  let seenCmd = "";
  const fakeSpawn = async (cmd: string) => {
    seenCmd = cmd;
    return { stdout: "codex reply", exitCode: 0 };
  };
  const r = await runLocalAgent(
    // 用户在卡上选了 codex，尽管 claude 也装着且排在前面
    { target: "codex-terminal", prompt: "x" },
    {
      spawn: fakeSpawn,
      ensureDir: () => {},
      detect: () => [
        detected("claude-terminal", "/abs/claude"),
        detected("codex-terminal", "/abs/codex"),
      ],
    },
  );
  expect(seenCmd).toBe("/abs/codex");
  expect(r.backend!.id).toBe("codex-terminal");
});

test("legacy wire value 'claude' aliases to claude-terminal", async () => {
  let seenCmd = "";
  const fakeSpawn = async (cmd: string) => {
    seenCmd = cmd;
    return { stdout: "ok", exitCode: 0 };
  };
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" }, // 旧 Slice-0 扩展传的裸 "claude"
    {
      spawn: fakeSpawn,
      ensureDir: () => {},
      detect: () => [detected("claude-terminal", "/abs/claude")],
    },
  );
  expect(seenCmd).toBe("/abs/claude");
  expect(r.backend!.id).toBe("claude-terminal");
});

test("explicit target not among installed headless backends → descriptive error (no silent fallback)", async () => {
  const fakeSpawn = async () => {
    throw new Error("spawn must not run for an invalid target");
  };
  await expect(
    runLocalAgent(
      { target: "codex-terminal", prompt: "x" }, // 只装了 claude，却选了 codex
      {
        spawn: fakeSpawn,
        ensureDir: () => {},
        detect: () => [detected("claude-terminal", "/abs/claude")],
      },
    ),
  ).rejects.toThrow(/requested backend "codex-terminal" is not an installed headless agent/);
});

test("explicit target pointing at an app form (no headlessArgv) → descriptive error", async () => {
  const fakeSpawn = async () => {
    throw new Error("spawn must not run for an app target");
  };
  await expect(
    runLocalAgent(
      { target: "claude-app", prompt: "x" },
      {
        spawn: fakeSpawn,
        ensureDir: () => {},
        detect: () => [
          detected("claude-app", "/Applications/Claude.app"),
          detected("codex-terminal", "/abs/codex"),
        ],
      },
    ),
  ).rejects.toThrow(/is not an installed headless agent/);
});

test("substitutes {prompt} into the backend's headless argv as a single raw arg", async () => {
  let seenArgs: string[] = [];
  const fakeSpawn = async (_cmd: string, args: string[]) => {
    seenArgs = args;
    return { stdout: "", exitCode: 0 };
  };
  // pi headlessArgv = ["-p", "{prompt}"]
  await runLocalAgent(
    { target: "pi-terminal", prompt: "prompt with spaces & 'quotes'" },
    {
      spawn: fakeSpawn,
      ensureDir: () => {},
      detect: () => [detected("pi-terminal", "/abs/pi")],
    },
  );
  // 原始 prompt 作为单一 argv 元素（不过 shell，无需引号转义）
  expect(seenArgs).toEqual(["-p", "prompt with spaces & 'quotes'"]);
});

test("app-only candidates are ignored (no headlessArgv) — default falls through to a terminal backend", async () => {
  let seenCmd = "";
  const fakeSpawn = async (cmd: string) => {
    seenCmd = cmd;
    return { stdout: "ok", exitCode: 0 };
  };
  const r = await runLocalAgent(
    { prompt: "x" }, // target 缺省
    {
      spawn: fakeSpawn,
      ensureDir: () => {},
      // claude-app 无 headlessArgv → 跳过，选 opencode-terminal
      detect: () => [
        detected("claude-app", "/Applications/Claude.app"),
        detected("opencode-terminal", "/abs/opencode"),
      ],
    },
  );
  expect(seenCmd).toBe("/abs/opencode");
  expect(r.backend!.id).toBe("opencode-terminal");
});

test("throws a descriptive error when no headless agent is installed", async () => {
  const fakeSpawn = async () => {
    throw new Error("spawn should not be called when no backend exists");
  };
  await expect(
    runLocalAgent(
      { target: "claude", prompt: "x" },
      { spawn: fakeSpawn, ensureDir: () => {}, detect: () => [] },
    ),
  ).rejects.toThrow(/no local headless agent detected/);
});

test("only an app is installed → throws (apps can't run headless)", async () => {
  await expect(
    runLocalAgent(
      { target: "claude", prompt: "x" },
      {
        spawn: async () => ({ stdout: "", exitCode: 0 }),
        ensureDir: () => {},
        detect: () => [detected("claude-app", "/Applications/Claude.app")],
      },
    ),
  ).rejects.toThrow(/no local headless agent detected/);
});

test("honors explicit cwd", async () => {
  const fakeSpawn = async (_c: string, _a: string[], cwd: string) => {
    expect(cwd).toBe("/tmp/proj");
    return { stdout: "ok", exitCode: 0 };
  };
  const fakeEnsureDir = (_dir: string) => {
    throw new Error("ensureDir should not be called when cwd is explicit");
  };
  const r = await runLocalAgent(
    { target: "claude", prompt: "x", cwd: "/tmp/proj" },
    { spawn: fakeSpawn, ensureDir: fakeEnsureDir, detect: () => [detected("claude-terminal", "/abs/claude")] },
  );
  expect(r.cwd).toBe("/tmp/proj");
});

// Finding 1 follow-up: stderr must be drained concurrently with stdout (never
// awaited-then-read), and a non-zero exit should carry a stderr tail in
// `output` so failures aren't silently empty. Zero exit stays untouched.
test("zero exit: output is stdout unchanged even when stderr has content", async () => {
  const fakeSpawn = async () => ({ stdout: "AGENT REPLY", exitCode: 0, stderr: "some warning noise" });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {}, detect: () => [detected("claude-terminal", "/abs/claude")] },
  );
  expect(r.output).toBe("AGENT REPLY");
  expect(r.exitCode).toBe(0);
});

test("non-zero exit: stderr tail is appended to output for diagnostics", async () => {
  const fakeSpawn = async () => ({ stdout: "", exitCode: 1, stderr: "boom: something broke\n" });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {}, detect: () => [detected("claude-terminal", "/abs/claude")] },
  );
  expect(r.exitCode).toBe(1);
  expect(r.output).toContain("boom: something broke");
});

test("non-zero exit: stdout and stderr tail are both present, stdout first", async () => {
  const fakeSpawn = async () => ({ stdout: "partial output", exitCode: 2, stderr: "fatal error" });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {}, detect: () => [detected("claude-terminal", "/abs/claude")] },
  );
  expect(r.output.indexOf("partial output")).toBeLessThan(r.output.indexOf("fatal error"));
});

test("non-zero exit with no stderr: output stays as stdout (no stray tail)", async () => {
  const fakeSpawn = async () => ({ stdout: "still nothing", exitCode: 1, stderr: "" });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {}, detect: () => [detected("claude-terminal", "/abs/claude")] },
  );
  expect(r.output).toBe("still nothing");
});

test("non-zero exit: fake spawn omitting stderr entirely does not throw", async () => {
  // Backward-compat: SpawnFn.stderr is optional; older/simpler fakes may omit it.
  const fakeSpawn = async () => ({ stdout: "x", exitCode: 1 });
  const r = await runLocalAgent(
    { target: "claude", prompt: "x" },
    { spawn: fakeSpawn, ensureDir: () => {}, detect: () => [detected("claude-terminal", "/abs/claude")] },
  );
  expect(r.output).toBe("x");
  expect(r.exitCode).toBe(1);
});
