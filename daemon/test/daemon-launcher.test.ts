import { test, expect, beforeAll } from "bun:test";
import type { Socket } from "bun";
import {
  RECONNECT_DELAYS_MS,
  reconnectDelay,
  connectWithBootstrap,
  spawnDetachedDaemon,
  isAddrInUseError,
} from "../src/daemon-launcher";
import { setLogEnabled } from "../src/log";

beforeAll(() => setLogEnabled(false)); // hermetic：不写真实 ~/.pie/logs

// Socket 是不透明句柄，测试只需一个占位对象断言「原样透传」。
const FAKE_SOCKET = { _fake: true } as unknown as Socket;

test("reconnectDelay 走 1s→30s 梯子并在末端钳住", () => {
  expect(RECONNECT_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 15_000, 30_000]);
  expect(reconnectDelay(0)).toBe(1_000);
  expect(reconnectDelay(4)).toBe(30_000);
  expect(reconnectDelay(99)).toBe(30_000); // 越界钳到末端
  expect(reconnectDelay(-1)).toBe(1_000); // 负数钳到头
});

test("首连即成功：不拉起 daemon、不等待，原样返回 socket", async () => {
  let spawned = 0;
  const sleeps: number[] = [];
  const sock = await connectWithBootstrap({
    connect: async () => FAKE_SOCKET,
    spawnDaemon: () => spawned++,
    sleep: async (ms) => void sleeps.push(ms),
  });
  expect(sock).toBe(FAKE_SOCKET);
  expect(spawned).toBe(0);
  expect(sleeps).toEqual([]);
});

test("连不上→拉起 daemon 一次→按退避梯子重连→连上后返回", async () => {
  let attempts = 0;
  let spawned = 0;
  const sleeps: number[] = [];
  const sock = await connectWithBootstrap({
    // 前两次拒（daemon 还没起来），第三次连上
    connect: async () => {
      attempts++;
      if (attempts < 3) throw new Error("ECONNREFUSED");
      return FAKE_SOCKET;
    },
    spawnDaemon: () => spawned++,
    sleep: async (ms) => void sleeps.push(ms),
    delays: [10, 20, 30, 40, 50],
  });
  expect(sock).toBe(FAKE_SOCKET);
  expect(attempts).toBe(3);
  expect(spawned).toBe(1); // 只拉一次，多余交给单实例互斥挡
  expect(sleeps).toEqual([10, 20]); // 两次失败 → 两次退避，梯子从头走
});

test("拉起只发生一次，即便重连多轮", async () => {
  let attempts = 0;
  let spawned = 0;
  await connectWithBootstrap({
    connect: async () => {
      attempts++;
      if (attempts < 5) throw new Error("nope");
      return FAKE_SOCKET;
    },
    spawnDaemon: () => spawned++,
    sleep: async () => {},
    delays: [1, 1, 1, 1, 1],
  });
  expect(attempts).toBe(5);
  expect(spawned).toBe(1);
});

test("梯子走完仍连不上：抛最后一次错误，daemon 只拉过一次", async () => {
  let spawned = 0;
  let attempts = 0;
  await expect(
    connectWithBootstrap({
      connect: async () => {
        attempts++;
        throw new Error(`fail-${attempts}`);
      },
      spawnDaemon: () => spawned++,
      sleep: async () => {},
      delays: [1, 2, 3], // 3 级梯子 → 共 4 次 connect（attempt 0..3）
    }),
  ).rejects.toThrow("fail-4");
  expect(attempts).toBe(4); // delays.length + 1
  expect(spawned).toBe(1);
});

test("spawnDetachedDaemon 用 detached/无窗口选项 spawn 而不抛（冒烟）", () => {
  // 传一个无害的短命 exe：detached+unref 后不阻塞测试进程；此测只验 spawn 选项在
  // 本平台合法、调用返回 void。真机无窗口 detach 行为走 need-human-test。
  const benign = process.platform === "win32" ? "cmd.exe" : "/usr/bin/true";
  expect(() => spawnDetachedDaemon(benign)).not.toThrow();
});

// ── 单实例互斥判定 ───────────────────────────────────────────────────
// 真实 named pipe 名冲突只在 Windows 复现（Linux 的 Bun.listen 对 unix socket 走
// unlink-rebind、不抛）。故这里用 predicate 单测覆盖 Bun 在 Windows named pipe 占用
// 时抛出的 EADDRINUSE 各种形态，daemon 据此干净退出把地盘让给现有实例。
test("isAddrInUseError 认得 EADDRINUSE 的各种形态", () => {
  expect(isAddrInUseError({ code: "EADDRINUSE" })).toBe(true);
  expect(isAddrInUseError({ errno: "EADDRINUSE" })).toBe(true);
  expect(isAddrInUseError(new Error("listen EADDRINUSE: address already in use"))).toBe(true);
  expect(isAddrInUseError(new Error("Failed to listen: address in use"))).toBe(true);
  expect(isAddrInUseError({ message: "already in use" })).toBe(true);
});

test("isAddrInUseError 不误判其它错误 / 非对象", () => {
  expect(isAddrInUseError({ code: "ECONNREFUSED" })).toBe(false);
  expect(isAddrInUseError(new Error("permission denied"))).toBe(false);
  expect(isAddrInUseError(null)).toBe(false);
  expect(isAddrInUseError(undefined)).toBe(false);
  expect(isAddrInUseError("EADDRINUSE")).toBe(false); // 字符串不是 error 对象
});
