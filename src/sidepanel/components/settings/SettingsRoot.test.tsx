import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import SettingsRoot, { helpCoords } from "./SettingsRoot";
import { setCdpInputEnabled } from "@/lib/cdp-input-enabled";

vi.mock("@/lib/cdp-input-enabled", () => ({
  isCdpInputEnabled: vi.fn().mockResolvedValue(false),
  setCdpInputEnabled: vi.fn().mockResolvedValue(undefined),
}));

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
  it("renders seven drill-down rows; row-models triggers onOpenPage('models')", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    for (const id of [
      "models",
      "bridge",
      "search",
      "uiLanguage",
      "assistantLanguage",
      "feedback",
      "about",
    ]) {
      expect(screen.getByTestId(`settings-row-${id}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("settings-row-models"));
    expect(p.onOpenPage).toHaveBeenCalledWith("models");
  });

  // CDP lives inline in the root page (no sub-page): a switch + a "?" popover.
  it("CDP row is an inline switch, not a drill-down", async () => {
    render(<SettingsRoot {...make()} />);
    expect(screen.queryByTestId("settings-row-cdp")).toBeNull();
    const sw = screen.getByRole("switch");
    fireEvent.click(sw);
    await waitFor(() => expect(setCdpInputEnabled).toHaveBeenCalledWith(true));
  });

  it("CDP '?' reveals the explainer on hover and hides it on leave", async () => {
    render(<SettingsRoot {...make()} />);
    const help = screen.getByTestId("cdp-help");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(help);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());
    fireEvent.mouseLeave(help);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("CDP '?' also reveals the explainer on keyboard focus", async () => {
    render(<SettingsRoot {...make()} />);
    fireEvent.focus(screen.getByTestId("cdp-help"));
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());
  });
});

describe("helpCoords", () => {
  const rect = (left: number) => ({ left }) as DOMRect;

  it("left-aligns to the trigger when there is room", () => {
    expect(helpCoords(rect(100), 420)).toEqual({ left: 88, width: 280 });
  });

  it("clamps inside the panel when the trigger sits far right", () => {
    // 420-wide panel: an unclamped popover at left=203 would end at 483 (off-screen).
    expect(helpCoords(rect(215), 420)).toEqual({ left: 132, width: 280 });
  });

  it("shrinks below the min width on a very narrow panel", () => {
    expect(helpCoords(rect(10), 200)).toEqual({ left: 8, width: 184 });
  });

  it("language rows drill into their sub-pages", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    fireEvent.click(screen.getByTestId("settings-row-uiLanguage"));
    expect(p.onOpenPage).toHaveBeenCalledWith("uiLanguage");
    fireEvent.click(screen.getByTestId("settings-row-assistantLanguage"));
    expect(p.onOpenPage).toHaveBeenCalledWith("assistantLanguage");
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

  it("about row drills into the About page and badges the manifest version", () => {
    const p = make();
    render(<SettingsRoot {...p} />);
    expect(screen.getByTestId("settings-badge-about").textContent).toContain("9.9.9");
    fireEvent.click(screen.getByTestId("settings-row-about"));
    expect(p.onOpenPage).toHaveBeenCalledWith("about");
  });
});
