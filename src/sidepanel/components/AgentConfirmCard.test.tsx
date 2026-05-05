import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import AgentConfirmCard from "./AgentConfirmCard";

const REQUIRED_PROPS = {
  tool: "capture_visible_tab",
  args: {},
  resolvedElement: { text: "", tag: "div" },
  riskReason: "Screenshot captures the current tab",
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

afterEach(() => cleanup());

describe("AgentConfirmCard — Phase 5 screenshot preview", () => {
  it("renders screenshot preview when screenshotPreview prop is present", () => {
    render(
      <AgentConfirmCard
        {...REQUIRED_PROPS}
        screenshotPreview={{
          thumbnail: "AAAA",
          mediaType: "image/jpeg",
          width: 200,
          height: 100,
          capturedAt: Date.now(),
        }}
      />,
    );
    const img = screen.getByAltText(/screenshot preview/i);
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toContain("data:image/jpeg;base64,AAAA");
  });

  it("does not render screenshot preview when screenshotPreview is absent", () => {
    render(<AgentConfirmCard {...REQUIRED_PROPS} />);
    expect(screen.queryByAltText(/screenshot preview/i)).toBeNull();
  });
});

// ── v1.5 open_url confirm variant ────────────────────────────────────────────

const OPEN_URL_BASE_PROPS = {
  tool: "open_url",
  args: { url: "https://example.com/page", active: false },
  resolvedElement: { text: "", tag: "div" },
  riskReason: "Opens a new browser tab",
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

describe("AgentConfirmCard — open_url confirm variant", () => {
  it("renders URL inline when ≤1024 chars and 'loads in background' when active=false", () => {
    render(
      <AgentConfirmCard
        {...OPEN_URL_BASE_PROPS}
        openUrlPreview={{
          url: "https://example.com/short",
          host: "example.com",
          origin: "https://example.com",
          active: false,
        }}
      />,
    );
    // Open the Details block so text is visible
    const details = document.querySelector("details")!;
    details.setAttribute("open", "");

    // URL text is inside the open-url preview region
    const region = screen.getByRole("region", { name: /open url preview/i });
    expect(region.textContent).toContain("https://example.com/short");
    // Host is displayed in the region
    expect(region.textContent).toContain("example.com");
    expect(screen.getByText(/loads in background/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /show full url/i })).toBeNull();
  });

  it("renders punycode host for IDN URLs", () => {
    render(
      <AgentConfirmCard
        {...OPEN_URL_BASE_PROPS}
        openUrlPreview={{
          url: "https://xn--80akhbyknj4f.com/page",
          host: "xn--80akhbyknj4f.com",
          origin: "https://xn--80akhbyknj4f.com",
          active: false,
        }}
      />,
    );
    const details = document.querySelector("details")!;
    details.setAttribute("open", "");

    // Host is displayed in the open-url preview region
    const region = screen.getByRole("region", { name: /open url preview/i });
    expect(region.textContent).toContain("xn--80akhbyknj4f.com");
  });

  it("renders WILL STEAL FOCUS badge when active=true", () => {
    render(
      <AgentConfirmCard
        {...OPEN_URL_BASE_PROPS}
        openUrlPreview={{
          url: "https://example.com/",
          host: "example.com",
          origin: "https://example.com",
          active: true,
        }}
      />,
    );
    const details = document.querySelector("details")!;
    details.setAttribute("open", "");

    expect(screen.getByText(/will steal focus/i)).toBeTruthy();
    expect(screen.queryByText(/loads in background/i)).toBeNull();
  });

  it("folds URL ≥1024 chars and expands on 'show full URL' click", async () => {
    const longUrl = "https://example.com/" + "x".repeat(2000);
    render(
      <AgentConfirmCard
        {...OPEN_URL_BASE_PROPS}
        openUrlPreview={{
          url: longUrl,
          host: "example.com",
          origin: "https://example.com",
          active: false,
        }}
      />,
    );
    const details = document.querySelector("details")!;
    details.setAttribute("open", "");

    const showBtn = screen.getByRole("button", { name: /show full url/i });
    expect(showBtn).toBeTruthy();
    // Full URL not yet visible
    expect(screen.queryByText(longUrl)).toBeNull();

    showBtn.click();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /show full url/i })).toBeNull();
    });
    // Full URL now displayed
    expect(screen.getByText(longUrl)).toBeTruthy();
  });
});
