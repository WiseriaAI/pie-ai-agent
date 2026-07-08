/**
 * Settings General tab — LocalBridgeSection grants revocation UI (Slice 2b Task 7).
 *
 * Mirrors the heavy-stub pattern from SettingsTabs.test.tsx (Settings.tsx pulls
 * in a lot of storage/crypto-backed sub-components that need stubbing to render
 * in happy-dom). Focused assertions:
 *   - once the bridge reports ready + `skill-grants:list` returns a grant, the
 *     General tab renders its skillId + entry and a revoke action
 *   - clicking revoke posts `skill-grants:revoke` with the grant's key
 */

import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import Settings from "../Settings";

// ── Stub out heavy sub-components that would need real storage / network ──────

vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn().mockResolvedValue([]),
  createInstance: vi.fn().mockResolvedValue(undefined),
  updateInstance: vi.fn().mockResolvedValue(undefined),
  deleteInstance: vi.fn().mockResolvedValue(undefined),
  firstModelForProvider: vi.fn().mockResolvedValue(null),
  getActiveInstance: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/model-router", () => ({
  chat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/model-router/providers/registry", () => ({
  getProviderMeta: vi.fn().mockReturnValue(null),
  resolveProviderMeta: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/provider-custom-models", () => ({
  getProviderCustomModels: vi.fn().mockResolvedValue([]),
  addProviderCustomModel: vi.fn().mockResolvedValue(undefined),
  removeProviderCustomModel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-custom-model-meta", () => ({
  getProviderCustomModelMetas: vi.fn().mockResolvedValue({}),
  setProviderCustomModelMeta: vi.fn().mockResolvedValue(undefined),
  removeProviderCustomModelMeta: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/custom-providers", () => ({
  addCustomProviderModel: vi.fn().mockResolvedValue(undefined),
  updateCustomProviderModel: vi.fn().mockResolvedValue(undefined),
  removeCustomProviderModel: vi.fn().mockResolvedValue(undefined),
  listCustomProviders: vi.fn().mockResolvedValue([]),
  CUSTOM_PREFIX: "custom:",
  providerRefToId: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/openrouter-models-fetch", () => ({
  fetchOpenRouterModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/cdp-input-enabled", () => ({
  isCdpInputEnabled: vi.fn().mockResolvedValue(false),
  setCdpInputEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../SkillsList", () => ({
  default: () => <div data-testid="skills-list" />,
}));

vi.mock("../SearchProviderSection", () => ({
  default: () => <div data-testid="search-provider-section" />,
}));

afterEach(() => {
  cleanup();
});

const GRANT = { key: "test-skill:abc123", skillId: "test-skill", entry: "scripts/save.js" };

/** Wires chrome.runtime.sendMessage to answer the message types LocalBridgeSection fires. */
function mockRuntime(opts: {
  grants?: { key: string; skillId: string; entry: string }[];
  revokeOk?: boolean;
}) {
  const sendMessage = vi.fn(
    (msg: { type: string; key?: string }, cb: (res: unknown) => void) => {
      if (msg.type === "local-bridge:status") cb({ hasPermission: true, ready: true });
      else if (msg.type === "local-agents:list") cb({ agents: [] });
      else if (msg.type === "skill-grants:list") cb({ grants: opts.grants ?? [] });
      else if (msg.type === "skill-grants:revoke") cb({ ok: opts.revokeOk ?? true });
    },
  );
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
    ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
    runtime: {
      ...((globalThis as unknown as { chrome: { runtime: object } }).chrome?.runtime ?? {}),
      sendMessage,
      lastError: undefined,
      getManifest: () => ({ version: "0.0.0-test" }),
    },
    i18n: { getUILanguage: () => "en" },
  };
  return sendMessage;
}

async function openGeneralTab() {
  render(<Settings onBack={vi.fn()} />);
  await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());
  const tabButtons = within(screen.getByTestId("settings-tabs")).getAllByRole("button");
  fireEvent.click(tabButtons[3]); // configs(0) skills(1) search(2) general(3)
}

describe("Settings General tab — grants revocation UI", () => {
  it("renders the authorized skill script (skillId + entry) once the bridge is ready", async () => {
    mockRuntime({ grants: [GRANT] });
    await openGeneralTab();

    await screen.findByText(/test-skill/);
    expect(screen.getByText(/scripts\/save\.js/)).toBeTruthy();
  });

  it("clicking revoke sends skill-grants:revoke with the grant's key", async () => {
    const sendMessage = mockRuntime({ grants: [GRANT], revokeOk: true });
    await openGeneralTab();

    await screen.findByText(/test-skill/);
    fireEvent.click(screen.getByRole("button", { name: /revoke|撤销/i }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "skill-grants:revoke", key: GRANT.key }),
        expect.any(Function),
      );
    });
  });

  it("does not render a grants section when the list is empty", async () => {
    mockRuntime({ grants: [] });
    await openGeneralTab();

    // give the queryGrants round-trip a tick to resolve before asserting absence
    await waitFor(() => expect(screen.getAllByRole("switch").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /revoke|撤销/i })).toBeNull();
  });
});
