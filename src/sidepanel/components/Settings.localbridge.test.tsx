/**
 * LocalBridgeSection — enabled-only main view + in-card "Manage agents" subview
 * (#270 Task 8). grants/audit display removed; grants control lives in SkillsList.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocalBridgeSection } from "./settings/pages/BridgePage";
import { chromeMock } from "@/test/setup";

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)", installed: true, enabled: true, kind: "app" },
  { id: "claude-terminal", label: "Claude Code (Terminal)", installed: true, enabled: false, kind: "terminal" },
  { id: "codex-terminal", label: "Codex (Terminal)", installed: false, enabled: false, kind: "terminal" },
];

type Handler = (message: Record<string, unknown>) => unknown;

function mockSendMessage(handlers: Record<string, Handler>): string[] {
  const seen: string[] = [];
  chromeMock.runtime.sendMessage.mockImplementation(((
    message: Record<string, unknown>,
    cb?: (res: unknown) => void,
  ) => {
    seen.push(message.type as string);
    const handler = handlers[message.type as string];
    const res = handler ? handler(message) : undefined;
    if (cb) cb(res);
    return Promise.resolve(res);
  }) as typeof chromeMock.runtime.sendMessage);
  return seen;
}

afterEach(() => cleanup());

const READY = { "local-bridge:status": () => ({ hasPermission: true, ready: true }) };

describe("LocalBridgeSection — enabled-only main view + manage subview", () => {
  it("main view lists ONLY enabled agents, without switches", async () => {
    mockSendMessage({ ...READY, "local-agents:list": () => ({ agents: AGENTS }) });
    render(<LocalBridgeSection />);
    // 已启用：claude-app（两行文案：名称 + kind 副标）
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("App")).toBeTruthy();
    // 未启用/未安装的不出现在主视图
    expect(screen.queryByText("Codex")).toBeFalsy();
    // 主视图无开关（唯一的 switch 是本地打通总开关）
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("manage link opens the in-card subview with ALL agents + toggles; back returns", async () => {
    mockSendMessage({ ...READY, "local-agents:list": () => ({ agents: AGENTS }) });
    render(<LocalBridgeSection />);
    fireEvent.click(await screen.findByText("Manage agents"));
    // 子视图：全量三行（含未安装 Codex），出现 agent 开关
    expect(await screen.findByText("Codex")).toBeTruthy();
    expect(screen.getByText(/Not installed/)).toBeTruthy();
    expect(screen.getAllByRole("switch").length).toBeGreaterThan(1);
    // 返回
    fireEvent.click(screen.getByLabelText("Back"));
    await waitFor(() => expect(screen.queryByText("Codex")).toBeFalsy());
  });

  it("toggling an agent in the subview sends local-agents:toggle", async () => {
    mockSendMessage({
      ...READY,
      "local-agents:list": () => ({ agents: AGENTS }),
      "local-agents:toggle": () => ({ ok: true }),
    });
    render(<LocalBridgeSection />);
    fireEvent.click(await screen.findByText("Manage agents"));
    const switches = await screen.findAllByRole("switch");
    fireEvent.click(switches[1]); // 第一个 agent 行开关（index 0 是总开关）
    await waitFor(() => {
      expect(
        chromeMock.runtime.sendMessage.mock.calls.some(
          (c) => (c[0] as { type?: string }).type === "local-agents:toggle",
        ),
      ).toBe(true);
    });
  });

  it("bridge drop while in subview forces back to main", async () => {
    let ready = true;
    mockSendMessage({
      "local-bridge:status": () => ({ hasPermission: true, ready }),
      "local-agents:list": () => ({ agents: AGENTS }),
    });
    render(<LocalBridgeSection />);
    fireEvent.click(await screen.findByText("Manage agents"));
    expect(await screen.findByText("Codex")).toBeTruthy();
    ready = false; // 下一个 1.5s 轮询读到 not-ready → effect 强制回主视图
    await waitFor(() => expect(screen.queryByText("Codex")).toBeFalsy(), { timeout: 4000 });
  });

  it("never queries grants or audit", async () => {
    const seen = mockSendMessage({ ...READY, "local-agents:list": () => ({ agents: AGENTS }) });
    render(<LocalBridgeSection />);
    await screen.findByText("Claude Code");
    expect(seen).not.toContain("local-grants:list");
    expect(seen).not.toContain("local-audit:list");
  });

  it("falls back to single-line label when kind is missing (old daemon)", async () => {
    mockSendMessage({
      ...READY,
      "local-agents:list": () => ({
        agents: [{ id: "claude-app", label: "Claude Code (App)", installed: true, enabled: true }],
      }),
    });
    render(<LocalBridgeSection />);
    expect(await screen.findByText("Claude Code (App)")).toBeTruthy();
  });
});

describe("LocalBridgeSection — daemon version handshake (Slice 3)", () => {
  it("shows the daemon version when connected", async () => {
    mockSendMessage({
      "local-bridge:status": () => ({
        hasPermission: true,
        ready: true,
        daemonVersion: "0.1.0",
        needsUpgrade: false,
        protocolMismatch: false,
      }),
      "local-agents:list": () => ({ agents: [] }),
    });

    render(<LocalBridgeSection />);
    expect(await screen.findByText(/0\.1\.0/)).toBeTruthy();
  });

  it("shows the soft-upgrade card with download link when needsUpgrade", async () => {
    mockSendMessage({
      "local-bridge:status": () => ({
        hasPermission: true,
        ready: true,
        daemonVersion: "0.0.9",
        needsUpgrade: true,
        protocolMismatch: false,
      }),
      "local-agents:list": () => ({ agents: [] }),
    });

    render(<LocalBridgeSection />);
    const link = await screen.findByRole("link", { name: /update|升级|更新/i });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link.pkg",
    );
  });

  it("shows the hard-incompatible upgrade text when protocolMismatch (not ready)", async () => {
    // 真机运行时状态：protocol 硬不兼容时握手不置 ready → ready:false。
    // 升级卡与强状态文案都必须在这个状态下渲染（不能被 ready 门住）。
    mockSendMessage({
      "local-bridge:status": () => ({
        hasPermission: true,
        ready: false,
        daemonVersion: null,
        needsUpgrade: false,
        protocolMismatch: true,
      }),
      "local-agents:list": () => ({ agents: [] }),
    });

    render(<LocalBridgeSection />);
    const link = await screen.findByRole("link", { name: /update|升级|更新/i });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link.pkg",
    );
    // 升级卡强文案（incompatible），区别于软提示
    expect(screen.getByText(/is incompatible with this extension/i)).toBeTruthy();
    // 状态行给出独立的「不兼容」文案，而非普通「未连接」
    expect(screen.getByText(/incompatible version/i)).toBeTruthy();
    expect(screen.queryByText(/not connected/i)).toBeNull();
  });
});
