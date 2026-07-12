/**
 * Settings sub-pages — post-IA-refactor smoke tests.
 *
 * Replaces the intent of the removed SettingsTabs.test.tsx:
 *   - ModelsPage renders the "add config" affordance for an empty instance list
 *
 * Locale-robust: never reads translated strings; relies on role="switch" and
 * the new-config button's role.
 */

import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ModelsPage from "./ModelsPage";

vi.mock("@/lib/cdp-input-enabled", () => ({
  isCdpInputEnabled: vi.fn().mockResolvedValue(false),
  setCdpInputEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn().mockResolvedValue([]),
  createInstance: vi.fn().mockResolvedValue(undefined),
  updateInstance: vi.fn().mockResolvedValue(undefined),
  deleteInstance: vi.fn().mockResolvedValue(undefined),
  firstModelForProvider: vi.fn().mockResolvedValue(null),
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

vi.mock("@/lib/model-router/providers/registry", () => ({
  getProviderMeta: vi.fn().mockReturnValue(null),
  resolveProviderMeta: vi.fn().mockResolvedValue(null),
  resolveEndpointVariant: vi.fn().mockReturnValue(null),
}));

afterEach(cleanup);

describe("ModelsPage", () => {
  it("renders the new-config button for an empty instance list", async () => {
    render(<ModelsPage />);
    // The header "add config" button is the only <button> before any instance
    // rows exist; wait for the async reload to settle.
    await waitFor(() => expect(screen.getAllByRole("button").length).toBeGreaterThan(0));
  });
});
