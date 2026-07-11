import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROTOCOL_VERSION, type SkillAuthPayload } from "@/types/local-bridge";

// 一个可编程的假 native port
function makeFakePort() {
  const listeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    postMessage: vi.fn(),
    onMessage: { addListener: (cb: (m: unknown) => void) => listeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => disconnectListeners.push(cb) },
    disconnect: vi.fn(),
    _emit: (m: unknown) => listeners.forEach((cb) => cb(m)),
    _disconnect: () => disconnectListeners.forEach((cb) => cb()),
  };
}

describe("local-bridge", () => {
  let fakePort: ReturnType<typeof makeFakePort>;
  beforeEach(() => {
    vi.resetModules();
    fakePort = makeFakePort();
    (globalThis as any).chrome = {
      runtime: { connectNative: vi.fn(() => fakePort) },
    };
  });

  it("not ready before hello reply", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    expect(isBridgeReady()).toBe(false);
  });

  it("ready after hello reply with matching protocolVersion", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    // 抓 hello 请求，回 hello 响应
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent"] },
    });
    // hello 走 send() 返回的真实 Promise：resolve() 同步触发，但 .then() 里的
    // ready=true 要等下一个 microtask 才跑；flush 一次 microtask 队列再断言。
    await Promise.resolve();
    expect(isBridgeReady()).toBe(true);
  });

  it("requestLocalAgent resolves on matching id", async () => {
    const { initLocalBridge, requestLocalAgent } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({ id: helloReq.id, ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: [] } });

    const p = requestLocalAgent({ target: "claude", prompt: "hi" });
    const runReq = fakePort.postMessage.mock.calls[1][0] as { id: string };
    fakePort._emit({ id: runReq.id, ok: true, result: { output: "REPLY", exitCode: 0, cwd: "/tmp/x" } });
    await expect(p).resolves.toMatchObject({ output: "REPLY" });
  });

  it("connectNative called with the daemon host name", async () => {
    const { initLocalBridge } = await import("./local-bridge");
    initLocalBridge();
    expect((globalThis as any).chrome.runtime.connectNative).toHaveBeenCalledWith("ai.wiseria.pie");
  });

  it("connectNative throwing degrades silently: not ready, no exception escapes", async () => {
    (globalThis as any).chrome = {
      runtime: {
        connectNative: vi.fn(() => {
          throw new Error("daemon not installed / no nativeMessaging permission");
        }),
      },
    };
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    expect(() => initLocalBridge()).not.toThrow();
    expect(isBridgeReady()).toBe(false);
  });

  it("onDisconnect resets ready/port and rejects pending requests", async () => {
    const { initLocalBridge, isBridgeReady, requestLocalAgent } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({ id: helloReq.id, ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent"] } });
    await Promise.resolve();
    expect(isBridgeReady()).toBe(true);

    const p = requestLocalAgent({ target: "claude", prompt: "hi" });
    // 让 requestLocalAgent 的 postMessage 先跑一次 microtask，保证 pending 里已经登记了它
    await Promise.resolve();

    fakePort._disconnect();

    expect(isBridgeReady()).toBe(false);
    await expect(p).rejects.toThrow("bridge disconnected");
  });

  it("protocolVersion diff > 1 stays not ready", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION + 5, capabilities: ["run_local_agent"] },
    });
    await Promise.resolve();
    expect(isBridgeReady()).toBe(false);
  });

  it("protocolVersion diff === 1 (compat window boundary) is ready", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION + 1, capabilities: ["run_local_agent"] },
    });
    await Promise.resolve();
    expect(isBridgeReady()).toBe(true);
  });

  it("requestHandoff resolves on matching id with the handoff dir", async () => {
    const { initLocalBridge, requestHandoff } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent"] },
    });

    const p = requestHandoff({ target: "claude", context: "do the thing" });
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    expect(req.method).toBe("handoff_to_agent");
    fakePort._emit({ id: req.id, ok: true, result: { dir: "/Users/x/pie-handoffs/2026-07-06-do-the-thing" } });
    await expect(p).resolves.toMatchObject({ dir: "/Users/x/pie-handoffs/2026-07-06-do-the-thing" });
  });

  it("requestListAgents sends list_agents when daemon advertises the capability", async () => {
    const { initLocalBridge, requestListAgents } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent", "list_agents"] },
    });
    await Promise.resolve();

    const p = requestListAgents();
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    expect(req.method).toBe("list_agents");
    fakePort._emit({
      id: req.id, ok: true,
      result: { agents: [{ id: "claude-app", label: "Claude Code (App)", installed: true }] },
    });
    await expect(p).resolves.toEqual([{ id: "claude-app", label: "Claude Code (App)", installed: true }]);
  });

  it("requestListAgents degrades to single legacy claude entry when capability missing (old daemon)", async () => {
    const { initLocalBridge, requestListAgents } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent"] },
    });
    await Promise.resolve();

    await expect(requestListAgents()).resolves.toEqual([{ id: "claude", label: "Claude Code (Terminal)", installed: true }]);
    expect(fakePort.postMessage.mock.calls).toHaveLength(1); // 没有第二个 wire 请求
  });

  it("requestRunSkillScript maps needs_authorization to { needsAuth: true }", async () => {
    const { initLocalBridge, requestRunSkillScript } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["skill_fs"] },
    });
    await Promise.resolve();

    const p = requestRunSkillScript({ name: "demo", entry: "fetch.ts" });
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    expect(req.method).toBe("run_skill_script");
    fakePort._emit({
      id: req.id, ok: false,
      error: { code: "needs_authorization", message: "authorization required" },
    });
    await expect(p).resolves.toEqual({ ok: false, needsAuth: true });
  });

  it("requestRunSkillScript maps other errors to { needsAuth:false, error }", async () => {
    const { initLocalBridge, requestRunSkillScript } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["skill_fs"] },
    });
    await Promise.resolve();

    const p = requestRunSkillScript({ name: "demo", entry: "fetch.ts" });
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    fakePort._emit({
      id: req.id, ok: false,
      error: { code: "script_error", message: "script threw: boom" },
    });
    await expect(p).resolves.toEqual({ ok: false, needsAuth: false, error: "script threw: boom" });
  });

  it("requestRunSkillScript surfaces needs_authorization data as outcome.auth", async () => {
    const { initLocalBridge, requestRunSkillScript } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["skill_fs"] },
    });
    await Promise.resolve();

    const PAYLOAD: SkillAuthPayload = {
      skillName: "demo",
      description: "demo skill",
      envelope: { allowedDomains: [], extraWrites: [], runnableScripts: ["fetch.ts"] },
      envelopeHash: "abc123",
    };

    const p = requestRunSkillScript({ name: "s", entry: "e.ts" });
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    fakePort._emit({
      id: req.id, ok: false,
      error: { code: "needs_authorization", message: "authorization required", data: PAYLOAD },
    });
    const outcome = await p;
    expect(outcome).toMatchObject({ ok: false, needsAuth: true });
    expect((outcome as { auth?: SkillAuthPayload }).auth?.envelopeHash).toBe(PAYLOAD.envelopeHash);
  });

  it("needs_authorization without data (old daemon) → auth undefined", async () => {
    const { initLocalBridge, requestRunSkillScript } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["skill_fs"] },
    });
    await Promise.resolve();

    const p = requestRunSkillScript({ name: "s", entry: "e.ts" });
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    fakePort._emit({
      id: req.id, ok: false,
      error: { code: "needs_authorization", message: "authorization required" },
    });
    const outcome = await p;
    expect(outcome).toEqual({ ok: false, needsAuth: true, auth: undefined });
  });

  it("requestListAudit round-trips entries", async () => {
    const { initLocalBridge, requestListAudit } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["skill_fs"] },
    });
    await Promise.resolve();

    const p = requestListAudit({ limit: 10 });
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    expect(req.method).toBe("list_audit");
    const entries = [
      {
        ts: 1720000000000,
        skillName: "demo",
        entry: "fetch.ts",
        envelope: { allowedDomains: [], extraWrites: [], runnableScripts: ["fetch.ts"] },
        exitCode: 0,
        timedOut: false,
        truncated: false,
        ms: 42,
      },
    ];
    fakePort._emit({ id: req.id, ok: true, result: { entries } });
    await expect(p).resolves.toEqual({ entries });
  });

  it("requestListSkills round-trips result.skills", async () => {
    const { initLocalBridge, requestListSkills } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["skill_fs"] },
    });
    await Promise.resolve();

    const p = requestListSkills();
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    expect(req.method).toBe("list_skills");
    const skills = [
      {
        name: "demo",
        description: "demo skill",
        runnableScripts: ["fetch.ts"],
        declaredCaps: { network: [], write: [] },
        files: ["SKILL.md"],
      },
    ];
    fakePort._emit({ id: req.id, ok: true, result: { skills } });
    await expect(p).resolves.toEqual({ skills });
  });

  it("bridgeHasSkillFs true only when ready && capability present", async () => {
    // 场景一：ready 但 capabilities 不含 skill_fs
    {
      const { initLocalBridge, bridgeHasSkillFs } = await import("./local-bridge");
      initLocalBridge();
      expect(bridgeHasSkillFs()).toBe(false); // 还没 ready

      const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
      fakePort._emit({
        id: helloReq.id, ok: true,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent"] },
      });
      await Promise.resolve();
      expect(bridgeHasSkillFs()).toBe(false); // ready 但没有 skill_fs capability
    }

    // 场景二：ready 且 capabilities 含 skill_fs
    vi.resetModules();
    fakePort = makeFakePort();
    (globalThis as any).chrome = { runtime: { connectNative: vi.fn(() => fakePort) } };
    {
      const { initLocalBridge, bridgeHasSkillFs } = await import("./local-bridge");
      initLocalBridge();
      const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
      fakePort._emit({
        id: helloReq.id, ok: true,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "skill_fs"] },
      });
      await Promise.resolve();
      expect(bridgeHasSkillFs()).toBe(true);
    }
  });

  it("bridgeSettled resolves after handshake completes (and immediately when never inited)", async () => {
    const { initLocalBridge, bridgeSettled } = await import("./local-bridge");

    // 从未 init 过：bridgeSettled() 立即已 resolve
    await expect(bridgeSettled()).resolves.toBeUndefined();

    initLocalBridge();
    let settled = false;
    bridgeSettled().then(() => { settled = true; });

    // hello 还没回复：新一轮 settled promise 尚未落定
    await Promise.resolve();
    expect(settled).toBe(false);

    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: [] },
    });

    // 握手 .then 回调跑完（内部调用 settledResolve）+ settledPromise 自身的回调再跑一轮
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("bridgeSettled: overlapping initLocalBridge — both promises settle, no dangle", async () => {
    const { initLocalBridge, bridgeSettled } = await import("./local-bridge");

    // init A：hello 尚未回复
    const portA = fakePort;
    initLocalBridge();
    const pA = bridgeSettled();

    // A 的 hello 还没落定时 init B（connectNative 返回一个全新 fake port）
    const portB = makeFakePort();
    (globalThis as any).chrome.runtime.connectNative = vi.fn(() => portB);
    initLocalBridge();
    const pB = bridgeSettled();

    // 先回 A 的 hello（port A 上），再回 B 的（port B 上）
    const helloA = portA.postMessage.mock.calls[0][0] as { id: string };
    portA._emit({ id: helloA.id, ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: [] } });
    const helloB = portB.postMessage.mock.calls[0][0] as { id: string };
    portB._emit({ id: helloB.id, ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: [] } });

    // 两个 promise 都必须落定；race 短超时让悬空快速失败而不是拖满测试超时
    const timeout = (ms: number) =>
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dangling bridgeSettled promise")), ms));
    await expect(Promise.race([pA, timeout(500)])).resolves.toBeUndefined();
    await expect(Promise.race([pB, timeout(500)])).resolves.toBeUndefined();
  });

  it("maybeInitLocalBridge: bridgeSettled grabbed before permissions IPC resolves waits for handshake (cold-start race)", async () => {
    const { maybeInitLocalBridge, bridgeSettled, bridgeHasSkillFs } = await import("./local-bridge");

    // 可控的 permissions.contains deferred，模拟跨进程 IPC 尚未返回
    let grantPermission!: (v: boolean) => void;
    (globalThis as any).chrome.permissions = {
      contains: vi.fn(() => new Promise<boolean>((r) => { grantPermission = r; })),
    };

    void maybeInitLocalBridge();
    // 同 tick 抓 settled promise（模拟消息处理器在 permissions IPC 返回前就跑）
    const p = bridgeSettled();
    let settled = false;
    void p.then(() => { settled = true; });

    // permissions 还没回来：决策 promise 不许落定（否则首次读会误判成 IDB 模式）
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // permissions 回 true → initLocalBridge 发 hello
    grantPermission(true);
    await Promise.resolve();
    await Promise.resolve();

    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["skill_fs"] },
    });

    await p; // 决策 promise 链到握手落定
    expect(bridgeHasSkillFs()).toBe(true);
  });

  it("maybeInitLocalBridge: no-permission branch settles the early-grabbed bridgeSettled", async () => {
    const { maybeInitLocalBridge, bridgeSettled, isBridgeReady } = await import("./local-bridge");

    let grantPermission!: (v: boolean) => void;
    (globalThis as any).chrome.permissions = {
      contains: vi.fn(() => new Promise<boolean>((r) => { grantPermission = r; })),
    };

    void maybeInitLocalBridge();
    const p = bridgeSettled();

    grantPermission(false);
    await p; // 无权限分支也必须落定，绝不悬空
    expect(isBridgeReady()).toBe(false);
  });
});
