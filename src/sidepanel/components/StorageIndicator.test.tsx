import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/sessions/storage", () => ({
  getTotalBytes: vi.fn(async () => 2 * 1024 * 1024),
  listSessionsWithBytes: vi.fn(async () => [
    { id: "s1", title: "Big chat", status: "active", bytes: 5000 },
    { id: "s2", title: "Small chat", status: "paused", bytes: 100 },
  ]),
}));

import { StorageIndicator } from "./StorageIndicator";

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe("<StorageIndicator />", () => {
  it("shows total usage and stays collapsed initially", async () => {
    render(<StorageIndicator />);
    await waitFor(() => expect(screen.getByText("2.0 MB")).toBeTruthy());
    expect(screen.queryByText("Big chat")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the per-session breakdown on click", async () => {
    render(<StorageIndicator />);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Big chat")).toBeTruthy();
    expect(screen.getByText("Small chat")).toBeTruthy();
    // bigger session row shows its size
    expect(screen.getByText("4.9 KB")).toBeTruthy();
  });
});
