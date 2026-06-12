import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ManagedErrorCta from "./ManagedErrorCta";

afterEach(() => {
  cleanup();
});

describe("ManagedErrorCta", () => {
  it("budget kind → Manage subscription opens portal with the managed key", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedErrorCta kind="budget" deps={{ getManagedKey: async () => "sk-v", portal }} />);
    const btn = await screen.findByRole("button", { name: /manage subscription/i });
    fireEvent.click(btn);
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("renders nothing when there is no managed instance", async () => {
    const { container } = render(<ManagedErrorCta kind="budget" deps={{ getManagedKey: async () => null, portal: vi.fn() }} />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
