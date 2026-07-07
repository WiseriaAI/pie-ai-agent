import { describe, expect, it, vi } from "vitest";
import { createSandboxRpc } from "./sandbox-host";
import type { SandboxRunRequest } from "./skill-sandbox";

function makeRpc(opts?: { timeoutMs?: number; maxOutputBytes?: number }) {
  const posted: SandboxRunRequest[] = [];
  const recycle = vi.fn();
  const rpc = createSandboxRpc({
    ensurePort: async () => (msg) => posted.push(msg),
    recycle,
    timeoutMs: opts?.timeoutMs,
    maxOutputBytes: opts?.maxOutputBytes,
  });
  return { rpc, posted, recycle };
}

describe("createSandboxRpc", () => {
  it("run 发请求，handleReply 按 id 回填结果", async () => {
    const { rpc, posted } = makeRpc();
    const p = rpc.run("code-a", { x: 1 });
    // ensurePort() is a Promise even when "instantly" resolved (fake in this
    // fixture) — flush one microtask turn so the queued send actually lands
    // in `posted` before we inspect it. (See task-3-report.md for why this
    // is required rather than optional.)
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("skill-sandbox:run");
    expect(posted[0].code).toBe("code-a");
    rpc.handleReply({ type: "skill-sandbox:result", id: posted[0].id, ok: true, result: '{"y":2}' });
    expect(await p).toBe('{"y":2}');
  });

  it("并发请求各回各家（id 隔离）", async () => {
    const { rpc, posted } = makeRpc();
    const pa = rpc.run("a", null);
    const pb = rpc.run("b", null);
    await Promise.resolve();
    rpc.handleReply({ type: "skill-sandbox:result", id: posted[1].id, ok: true, result: '"B"' });
    rpc.handleReply({ type: "skill-sandbox:result", id: posted[0].id, ok: true, result: '"A"' });
    expect(await pa).toBe('"A"');
    expect(await pb).toBe('"B"');
  });

  it("ok:false → reject 带错误文案", async () => {
    const { rpc, posted } = makeRpc();
    const p = rpc.run("code", null);
    await Promise.resolve();
    rpc.handleReply({ type: "skill-sandbox:result", id: posted[0].id, ok: false, error: "boom" });
    await expect(p).rejects.toThrow("boom");
  });

  it("超时 → reject + recycle（楔死的脚本只能丢 iframe 杀）", async () => {
    vi.useFakeTimers();
    try {
      const { rpc, recycle } = makeRpc({ timeoutMs: 50 });
      const p = rpc.run("while(1){}", null);
      const assertion = expect(p).rejects.toThrow(/timed out after 50ms/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(recycle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时后的迟到 reply 被忽略（不 throw 不串台）", async () => {
    vi.useFakeTimers();
    try {
      const { rpc, posted } = makeRpc({ timeoutMs: 50 });
      const p = rpc.run("slow", null);
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      // 不应 throw：
      rpc.handleReply({ type: "skill-sandbox:result", id: posted[0].id, ok: true, result: '"late"' });
    } finally {
      vi.useRealTimers();
    }
  });

  it("输出超上限 → reject", async () => {
    const { rpc, posted } = makeRpc({ maxOutputBytes: 8 });
    const p = rpc.run("code", null);
    await Promise.resolve();
    rpc.handleReply({
      type: "skill-sandbox:result",
      id: posted[0].id,
      ok: true,
      result: '"0123456789"',
    });
    await expect(p).rejects.toThrow(/output too large/);
  });
});
