import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import ManagedAccountPanel from "./ManagedAccountPanel";
import type { Entitlement } from "@/lib/managed-auth";

afterEach(() => cleanup());

const active: Entitlement = {
  plan: "active", email: "u@x.com",
  subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false },
  quota: { weekly: { usedFraction: 0.71, resetAt: 1750400000 } },
  models: [{ id: "default", name: "标准" }],
};

describe("ManagedAccountPanel", () => {
  it("active：套餐名/邮箱/续费日/周额度条 + Manage subscription → portal", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => active), portal }} />);
    expect(await screen.findByText("Pie Pro")).toBeTruthy();
    expect(screen.getByText("u@x.com")).toBeTruthy();
    expect(screen.getByText(/^Renews /)).toBeTruthy();
    expect(screen.getByText("THIS WEEK")).toBeTruthy();
    expect(screen.getByText("71%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /manage subscription/i }));
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("active 取消续费：显示 Cancels + won't renew", async () => {
    const ent: Entitlement = { ...active, subscription: { ...active.subscription!, cancelAtPeriodEnd: true } };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent) }} />);
    expect(await screen.findByText(/^Cancels /)).toBeTruthy();
    expect(screen.getByText(/won't renew/)).toBeTruthy();
  });

  it("active 且 currentPeriodEnd=null：不报错、省略日期行、仍显示周额度", async () => {
    const ent: Entitlement = { ...active, subscription: { ...active.subscription!, currentPeriodEnd: null } };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent) }} />);
    expect(await screen.findByText("71%")).toBeTruthy();
    expect(screen.queryByText(/^Renews /)).toBeNull();
    expect(screen.queryByText(/^Cancels /)).toBeNull();
  });

  it("blocked：Payment failed + Update payment method → portal，无周额度条", async () => {
    const portal = vi.fn(async () => {});
    const ent: Entitlement = {
      plan: "blocked", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false },
      quota: null, models: [],
    };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent), portal }} />);
    expect(await screen.findByText(/Payment failed/)).toBeTruthy();
    expect(screen.queryByText("THIS WEEK")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /update payment method/i }));
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("none：No active subscription + Subscribe → checkout", async () => {
    const checkout = vi.fn(async () => {});
    const ent: Entitlement = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent), checkout }} />);
    expect(await screen.findByText(/No active subscription/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^subscribe$/i }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("sk-v"));
  });
});
