import { render, screen, cleanup } from "@testing-library/react";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import ProviderIcon from "./ProviderIcon";

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    ...((globalThis as unknown as { chrome?: object }).chrome ?? {}),
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
  };
});

afterEach(() => {
  cleanup();
});

describe("ProviderIcon", () => {
  it("renders a masked icon for a builtin provider that has iconAsset", () => {
    render(<ProviderIcon provider="anthropic" size={22} />);
    const img = screen.getByTestId("provider-icon-img");
    // CSS mask references the resolved asset url so the single-color svg
    // takes currentColor (visible on dark + light themes). happy-dom does not
    // serialize mask-image into cssText, so we assert the url via data attr.
    expect(img.getAttribute("data-icon-url")).toContain("provider-icons/anthropic.svg");
  });

  it("renders a monogram for a builtin provider without iconAsset (bailian)", () => {
    render(<ProviderIcon provider="bailian" size={22} />);
    expect(screen.queryByTestId("provider-icon-img")).toBeNull();
    expect(screen.getByText("B")).toBeTruthy(); // name "Bailian" → B
  });

  it("renders a monogram for any custom provider", () => {
    render(<ProviderIcon provider="custom:abc" size={22} />);
    expect(screen.queryByTestId("provider-icon-img")).toBeNull();
    expect(screen.getByText("A")).toBeTruthy(); // "abc" → A
  });
});
