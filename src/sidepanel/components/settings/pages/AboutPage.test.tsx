/**
 * AboutPage — settings sub-page replacing the old root-page About footer:
 * version hero + external links (all new-tab, noopener).
 */
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import AboutPage from "./AboutPage";

beforeEach(() => {
  Object.assign(chrome.runtime as unknown as Record<string, unknown>, {
    getManifest: () => ({ version: "9.9.9" }),
    getURL: (p: string) => `chrome-extension://id/${p}`,
  });
});

afterEach(cleanup);

describe("AboutPage", () => {
  it("shows the manifest version", () => {
    render(<AboutPage />);
    expect(screen.getByText("v9.9.9")).toBeTruthy();
  });

  it("renders five external links, each opening in a new tab with noopener", () => {
    render(<AboutPage />);
    const links = screen.getAllByRole("link") as HTMLAnchorElement[];
    expect(links).toHaveLength(5);
    for (const a of links) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\//);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    // privacy + license point at the repo docs, not a bare repo root
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.endsWith("/PRIVACY.md"))).toBe(true);
    expect(hrefs.some((h) => h?.endsWith("/LICENSE"))).toBe(true);
  });
});
