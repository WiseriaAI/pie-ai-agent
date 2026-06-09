import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FileAccessCard } from "./FileAccessCard";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    runtime: { id: "abc" },
    tabs: { create: vi.fn() },
    extension: { isAllowedFileSchemeAccess: vi.fn(async () => false) },
  });
});

describe("<FileAccessCard />", () => {
  it("renders the explanation and the open-settings button", () => {
    render(<FileAccessCard onDismiss={() => {}} />);
    expect(screen.getByText(/Reading local files needs permission/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /allow access/i })).toBeTruthy();
  });

  it("opens chrome://extensions for the extension id when the button is clicked", () => {
    const createSpy = vi.spyOn(chrome.tabs, "create");
    render(<FileAccessCard onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /allow access/i }));
    expect(createSpy).toHaveBeenCalledWith({
      url: "chrome://extensions/?id=abc",
    });
  });

  it("calls onDismiss when isAllowedFileSchemeAccess turns true on visibilitychange", async () => {
    const onDismiss = vi.fn();
    (vi.spyOn(chrome.extension, "isAllowedFileSchemeAccess") as unknown as { mockResolvedValue(v: boolean): void })
      .mockResolvedValue(true);
    render(<FileAccessCard onDismiss={onDismiss} />);
    document.dispatchEvent(new Event("visibilitychange"));
    // Allow effect to flush
    await Promise.resolve();
    await Promise.resolve();
    expect(onDismiss).toHaveBeenCalled();
  });
});
