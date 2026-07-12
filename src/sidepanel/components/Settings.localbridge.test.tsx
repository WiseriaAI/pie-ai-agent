/**
 * LocalBridgeSection — grants list/revoke + recent script runs (Task 7).
 *
 * Mocks chrome.runtime.sendMessage (callback form) dispatching by
 * message.type, mirroring the house pattern for local-bridge messages:
 * local-bridge:status / local-agents:list / local-grants:list /
 * local-grants:revoke / local-audit:list.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocalBridgeSection } from "./Settings";
import { chromeMock } from "@/test/setup";

const GRANT = {
  key: "skill:s:abc",
  skillName: "fetch-report",
  envelope: {
    allowedDomains: ["api.example.com"],
    extraWrites: [],
    runnableScripts: ["fetch.ts"],
  },
  grantedAt: 1700000000000,
};

const AUDIT_ENTRY = {
  ts: 1700000001000,
  skillName: "fetch-report",
  entry: "fetch.ts",
  envelope: {
    allowedDomains: ["api.example.com"],
    extraWrites: [],
    runnableScripts: ["fetch.ts"],
  },
  exitCode: 0,
  timedOut: false,
  truncated: false,
  ms: 120,
};

type Handler = (message: Record<string, unknown>) => unknown;

function mockSendMessage(handlers: Record<string, Handler>): void {
  chromeMock.runtime.sendMessage.mockImplementation(((
    message: Record<string, unknown>,
    cb?: (res: unknown) => void,
  ) => {
    const handler = handlers[message.type as string];
    const res = handler ? handler(message) : undefined;
    if (cb) cb(res);
    return Promise.resolve(res);
  }) as typeof chromeMock.runtime.sendMessage);
}

afterEach(() => {
  cleanup();
});

describe("LocalBridgeSection — grants & audit", () => {
  it("renders granted skills with envelope summary and revoke button", async () => {
    mockSendMessage({
      "local-bridge:status": () => ({ hasPermission: true, ready: true }),
      "local-agents:list": () => ({ agents: [] }),
      "local-grants:list": () => ({ grants: [GRANT] }),
      "local-audit:list": () => ({ entries: [] }),
    });

    render(<LocalBridgeSection />);

    expect(await screen.findByText("fetch-report")).toBeTruthy();
    expect(screen.getByText(/api\.example\.com/)).toBeTruthy();
    expect(screen.getByText(/Revoke/)).toBeTruthy();
  });

  it("revoke sends local-grants:revoke with the grant key and refreshes the list", async () => {
    let grants: (typeof GRANT)[] = [GRANT];
    mockSendMessage({
      "local-bridge:status": () => ({ hasPermission: true, ready: true }),
      "local-agents:list": () => ({ agents: [] }),
      "local-grants:list": () => ({ grants }),
      "local-grants:revoke": (m) => {
        expect(m.key).toBe(GRANT.key);
        grants = [];
        return { ok: true };
      },
      "local-audit:list": () => ({ entries: [] }),
    });

    render(<LocalBridgeSection />);
    await screen.findByText("fetch-report");

    fireEvent.click(screen.getByText(/Revoke/));

    await waitFor(() => {
      expect(screen.queryByText("fetch-report")).toBeNull();
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "local-grants:revoke", key: GRANT.key },
      expect.any(Function),
    );
  });

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
      "local-grants:list": () => ({ grants: [] }),
      "local-audit:list": () => ({ entries: [] }),
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
      "local-grants:list": () => ({ grants: [] }),
      "local-audit:list": () => ({ entries: [] }),
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
      "local-grants:list": () => ({ grants: [] }),
      "local-audit:list": () => ({ entries: [] }),
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

  it("renders recent runs from local-audit:list", async () => {
    mockSendMessage({
      "local-bridge:status": () => ({ hasPermission: true, ready: true }),
      "local-agents:list": () => ({ agents: [] }),
      "local-grants:list": () => ({ grants: [] }),
      "local-audit:list": () => ({ entries: [AUDIT_ENTRY] }),
    });

    render(<LocalBridgeSection />);

    fireEvent.click(await screen.findByText(/Recent script runs/i));
    expect(await screen.findByText(/fetch-report/)).toBeTruthy();
    expect(screen.getByText(/fetch\.ts/)).toBeTruthy();
  });
});
