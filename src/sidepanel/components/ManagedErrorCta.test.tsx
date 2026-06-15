import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ManagedErrorCta from "./ManagedErrorCta";
import type { Entitlement } from "@/lib/managed-auth";

afterEach(() => cleanup());

const ent = (over: Partial<Entitlement>): Entitlement => ({
  plan: "active", email: "u@x.com",
  subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe" },
  quota: { weekly: { usedFraction: 1, resetAt: 1750400000 } },
  models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 200000, costLevel: 1 }],
  ...over,
});

describe("ManagedErrorCta", () => {
  it("budget + active：信息态（等重置），无按钮", async () => {
    render(<ManagedErrorCta kind="budget" deps={{
      getManagedKey: async () => "sk-v",
      getEnt: async () => ent({ plan: "active" }),
    }} />);
    expect(await screen.findByText(/used this week's quota/i)).toBeTruthy();
    expect(screen.getByText(/^Resets /)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("budget + none：Subscribe → checkout", async () => {
    const checkout = vi.fn(async () => {});
    render(<ManagedErrorCta kind="budget" deps={{
      getManagedKey: async () => "sk-v",
      getEnt: async () => ent({ plan: "none", subscription: null, quota: null, models: [] }),
      checkout,
    }} />);
    const btn = await screen.findByRole("button", { name: /^subscribe$/i });
    fireEvent.click(btn);
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("sk-v"));
  });

  it("auth + blocked：Update payment → portal", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedErrorCta kind="auth" deps={{
      getManagedKey: async () => "sk-v",
      getEnt: async () => ent({ plan: "blocked", quota: null, models: [] }),
      portal,
    }} />);
    const btn = await screen.findByRole("button", { name: /update payment/i });
    fireEvent.click(btn);
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("budget + blocked：仍按 dunning 走 portal", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedErrorCta kind="budget" deps={{
      getManagedKey: async () => "sk-v",
      getEnt: async () => ent({ plan: "blocked", quota: null, models: [] }),
      portal,
    }} />);
    const btn = await screen.findByRole("button", { name: /update payment/i });
    fireEvent.click(btn);
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("无 managed key → 不渲染", async () => {
    const { container } = render(<ManagedErrorCta kind="budget" deps={{
      getManagedKey: async () => null,
      getEnt: async () => ent({}),
    }} />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("不随 re-render 重复拉取 entitlement（effect 仅依赖 kind）", async () => {
    const getEnt = vi.fn(async () => ent({ plan: "active" }));
    const props = () => ({
      kind: "budget" as const,
      deps: { getManagedKey: async () => "sk-v", getEnt },
    });
    const { rerender } = render(<ManagedErrorCta {...props()} />);
    await screen.findByText(/used this week's quota/i);
    rerender(<ManagedErrorCta {...props()} />);
    rerender(<ManagedErrorCta {...props()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(getEnt).toHaveBeenCalledTimes(1);
  });
});
