/**
 * SettingsTabs — IA restructure test
 *
 * Verifies that the 4-tab Settings redesign moved the experimental CDP toggle
 * (role="switch") OUT of the configs tab INTO the new general tab.
 *
 * Locale-robustness: we DO NOT hardcode Chinese or English tab labels.
 * Instead we rely on:
 *   - The switch's role="switch" as the locale-independent presence signal
 *   - Position-based tab selection (the 4th/last tab button = General)
 *
 * The test works regardless of whether the i18n context resolves to en or
 * zh-CN because it never reads translated strings to find the tab.
 */

import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import Settings from "../Settings";

// ── Stub out heavy sub-components that would need real storage / network ──────

// instances — return empty list so InstancesList renders without crypto setup
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

// cdp-input-enabled — controls the switch state
vi.mock("@/lib/cdp-input-enabled", () => ({
  isCdpInputEnabled: vi.fn().mockResolvedValue(false),
  setCdpInputEnabled: vi.fn().mockResolvedValue(undefined),
}));

// SkillsList — avoid loading the real component
vi.mock("../SkillsList", () => ({
  default: () => <div data-testid="skills-list" />,
}));

// SearchProviderSection — avoid loading the real component
vi.mock("../SearchProviderSection", () => ({
  default: () => <div data-testid="search-provider-section" />,
}));

// chrome.runtime.getManifest — required by FeedbackSection / AboutSection
(globalThis as unknown as { chrome: { runtime: { getManifest: () => { version: string } }; i18n: { getUILanguage: () => string } } }).chrome = {
  ...(globalThis as unknown as { chrome: object }).chrome,
  runtime: {
    ...((globalThis as unknown as { chrome: { runtime: object } }).chrome?.runtime ?? {}),
    getManifest: () => ({ version: "0.0.0-test" }),
  },
  i18n: {
    getUILanguage: () => "en",
  },
};

afterEach(() => {
  cleanup();
});

describe("Settings 4-tab IA", () => {
  it("configs tab (default): CDP toggle (role=switch) is NOT present", async () => {
    render(<Settings onBack={vi.fn()} />);

    // Wait for initial async data load (instances list etc.)
    await waitFor(() => {
      // The configs tab content renders; there should be NO switch
      expect(screen.queryByRole("switch")).toBeNull();
    });
  });

  it("configs tab header shows Add config action instead of config count", async () => {
    render(<Settings onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^\+ Add config$/i })).toBeTruthy();
    });
    expect(screen.queryByText(/^0 configs$/i)).toBeNull();
  });

  it("configs tab shows an empty-config banner before any config exists", async () => {
    render(<Settings onBack={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Configure a model service to continue. Click Add config in the top-right and use your existing API Key to get Pie working.",
        ),
      ).toBeTruthy();
    });
  });

  it("clicking the 4th tab (General) reveals the CDP toggle", async () => {
    render(<Settings onBack={vi.fn()} />);

    // Wait for the tab bar to be rendered — find all tab buttons
    // The tab bar is the first group of ≥4 buttons that are siblings.
    // We use a stable strategy: wait for the configs content, then find tabs.
    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());

    // Scope to the tab-bar container (data-testid) and read its buttons in
    // order: configs(0), skills(1), search(2), general(3). This is more robust
    // than positional slicing off the global button list.
    const tabButtons = within(screen.getByTestId("settings-tabs")).getAllByRole("button");
    expect(tabButtons).toHaveLength(4);

    // Click the 4th tab (General)
    fireEvent.click(tabButtons[3]);

    // The CDP switch (and progressive disclosure switch) should now appear
    await waitFor(() => {
      expect(screen.getAllByRole("switch").length).toBeGreaterThan(0);
    });
  });

  it("general tab About section links to the official website", async () => {
    render(<Settings onBack={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());
    const tabButtons = within(screen.getByTestId("settings-tabs")).getAllByRole("button");
    fireEvent.click(tabButtons[3]);

    const link = await screen.findByRole("link", { name: /official website/i });
    expect(link.getAttribute("href")).toBe("https://www.pie.chat/");
  });

  it("configs tab: after switching back from General, switch is gone again", async () => {
    render(<Settings onBack={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());

    const tabButtons = within(screen.getByTestId("settings-tabs")).getAllByRole("button");

    // Go to General
    fireEvent.click(tabButtons[3]);
    await waitFor(() => expect(screen.getAllByRole("switch").length).toBeGreaterThan(0));

    // Go back to Configs (first tab)
    fireEvent.click(tabButtons[0]);
    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());
  });
});
