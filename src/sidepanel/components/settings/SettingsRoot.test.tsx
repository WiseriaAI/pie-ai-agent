import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import SettingsRoot from "./SettingsRoot";

vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn().mockResolvedValue([
    { id: "a", provider: "anthropic", nickname: "One", apiKey: "k", createdAt: 0 },
    { id: "b", provider: "openai", nickname: "Two", apiKey: "k", createdAt: 0 },
  ]),
}));

vi.mock("@/lib/search-provider", () => ({
  ACTIVE_SEARCH_PROVIDER: "tavily",
  getSearchProviderStatus: vi.fn().mockResolvedValue({ configured: true }),
}));

vi.mock("@/sidepanel/components/LanguageSelect", () => ({
  default: () => <div data-testid="ui-language-select" />,
}));
vi.mock("@/sidepanel/components/AssistantLanguageSelect", () => ({
  default: () => <div data-testid="assistant-language-select" />,
}));

beforeEach(() => {
  (chrome.runtime as unknown as { getManifest: () => { version: string } }).getManifest = () => ({
    version: "9.9.9",
  });
});

afterEach(cleanup);

function make(over: Partial<React.ComponentProps<typeof SettingsRoot>> = {}) {
  return {
    themeMode: "system" as const,
    onThemeModeChange: vi.fn(),
    onOpenPage: vi.fn(),
    ...over,
  };
}

describe("SettingsRoot", () => {
  it("renders five drill-down rows; row-models triggers onOpenPage('models')", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    for (const id of ["models", "bridge", "search", "experimental", "feedback"]) {
      expect(screen.getByTestId(`settings-row-${id}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("settings-row-models"));
    expect(p.onOpenPage).toHaveBeenCalledWith("models");
  });

  it("models row shows a config-count badge", async () => {
    render(<SettingsRoot {...make()} />);
    await waitFor(() => expect(screen.getByTestId("settings-badge-models")).toBeTruthy());
  });

  it("search row shows the configured provider badge", async () => {
    render(<SettingsRoot {...make()} />);
    await waitFor(() => expect(screen.getByTestId("settings-badge-search")).toBeTruthy());
  });

  it("theme segmented has three segments; clicking light fires onThemeModeChange('light')", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    expect(screen.getByTestId("theme-light")).toBeTruthy();
    expect(screen.getByTestId("theme-dark")).toBeTruthy();
    expect(screen.getByTestId("theme-system")).toBeTruthy();
    fireEvent.click(screen.getByTestId("theme-light"));
    expect(p.onThemeModeChange).toHaveBeenCalledWith("light");
  });

  it("renders language selectors", () => {
    render(<SettingsRoot {...make()} />);
    expect(screen.getByTestId("ui-language-select")).toBeTruthy();
    expect(screen.getByTestId("assistant-language-select")).toBeTruthy();
  });

  it("About footer shows the manifest version", () => {
    render(<SettingsRoot {...make()} />);
    expect(screen.getByText(/9\.9\.9/)).toBeTruthy();
  });
});
