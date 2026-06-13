import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import ManagedAccountPanel from "./ManagedAccountPanel";

afterEach(() => {
  cleanup();
});

describe("ManagedAccountPanel", () => {
  it("shows plan + budget and a Manage button for active subscriptions", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedAccountPanel apiKey="sk-v" deps={{
      refresh: vi.fn(async (): Promise<import("@/lib/managed-auth").Entitlement> => ({ plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: { weekly: { usedFraction: 0.71, resetAt: 1750400000 } }, models: [{ id: "default", name: "标准" }] })),
      portal,
    }} />);
    await screen.findByText(/active/i);
    expect(screen.getByText(/u@x.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /manage subscription/i }));
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });
});
