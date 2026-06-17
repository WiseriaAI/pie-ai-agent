import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import ManagedAccountPanel from "./ManagedAccountPanel";
import type { Entitlement } from "@/lib/managed-auth";

afterEach(() => cleanup());

const active: Entitlement = {
  plan: "active", email: "u@x.com",
  subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe" },
  quota: { weekly: { usedFraction: 0.71, resetAt: 1750400000 } },
  models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 200000, costLevel: 1 }],
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
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe" },
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

  it("redemption 来源：隐藏'管理订阅'、显示兑换有效期、显示兑换输入框", async () => {
    const portal = vi.fn(async () => {});
    const ent: Entitlement = {
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: true, source: "redemption" },
      quota: { weekly: { usedFraction: 0.2, resetAt: 1750400000 } }, models: [],
    };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent), portal }} />);
    expect(await screen.findByText(/Active via code/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /manage subscription/i })).toBeNull();
    expect(screen.queryByText(/^Cancels /)).toBeNull(); // 不复用 cancels 文案
    expect(screen.getByPlaceholderText(/PIE-/)).toBeTruthy(); // 可再兑换延期
  });

  it("redemption 再兑换成功 → 刷新展示（不再调 portal）", async () => {
    const ext: Entitlement = {
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1760000000, cancelAtPeriodEnd: true, source: "redemption" },
      quota: null, models: [],
    };
    const start: Entitlement = { ...ext, subscription: { ...ext.subscription!, currentPeriodEnd: 1750000000 } };
    const redeem = vi.fn(async () => ext);
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => start), redeem }} />);
    await screen.findByText(/Active via code/i);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "PIE-AAAAA-BBBBB-CCCCC" } });
    fireEvent.click(screen.getByRole("button", { name: /^redeem$/i }));
    await waitFor(() => expect(redeem).toHaveBeenCalledWith("sk-v", "PIE-AAAAA-BBBBB-CCCCC"));
  });

  it("active stripe + interval=year → 显示「按年计费」", async () => {
    const refresh = vi.fn(async (): Promise<Entitlement> => ({
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe", interval: "year" },
      quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [],
    }));
    render(<ManagedAccountPanel apiKey="sk-acc-y" deps={{ refresh }} />);
    expect(await screen.findByText(/billed yearly/i)).toBeTruthy();
  });

  it("active stripe + interval=month → 显示「按月计费」", async () => {
    const refresh = vi.fn(async (): Promise<Entitlement> => ({
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe", interval: "month" },
      quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [],
    }));
    render(<ManagedAccountPanel apiKey="sk-acc-m" deps={{ refresh }} />);
    expect(await screen.findByText(/billed monthly/i)).toBeTruthy();
  });

  it("redemption（无 interval）→ 不显示计费周期标签", async () => {
    const refresh = vi.fn(async (): Promise<Entitlement> => ({
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: true, source: "redemption" },
      quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [],
    }));
    render(<ManagedAccountPanel apiKey="sk-acc-r" deps={{ refresh }} />);
    await screen.findByText(/active via code/i); // 等渲染完成（redeemedUntil 文案）
    expect(screen.queryByText(/billed/i)).toBeNull();
  });
});
