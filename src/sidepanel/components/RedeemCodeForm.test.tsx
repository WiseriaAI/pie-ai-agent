import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import RedeemCodeForm from "./RedeemCodeForm";
import { RedeemError } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";

afterEach(() => cleanup());

const activeRedemption: Entitlement = {
  plan: "active", email: "u@x.com",
  subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" },
  quota: null, models: [],
};

describe("RedeemCodeForm", () => {
  it("输入码 + 兑换成功 → 调 redeem 并回调 onRedeemed", async () => {
    const redeem = vi.fn(async () => activeRedemption);
    const onRedeemed = vi.fn();
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={onRedeemed} deps={{ redeem }} />);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: " pie-aaaaa-bbbbb-ccccc " } });
    fireEvent.click(screen.getByRole("button", { name: /redeem/i }));
    await waitFor(() => expect(onRedeemed).toHaveBeenCalledWith(activeRedemption));
    expect(redeem).toHaveBeenCalledWith("sk-v", "pie-aaaaa-bbbbb-ccccc"); // trim
  });

  it("空输入时按钮禁用、不调用", () => {
    const redeem = vi.fn();
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={vi.fn()} deps={{ redeem }} />);
    const btn = screen.getByRole("button", { name: /redeem/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("RedeemError(code_already_redeemed) → 显示本地化错误、不回调", async () => {
    const redeem = vi.fn(async () => { throw new RedeemError("code_already_redeemed", 409); });
    const onRedeemed = vi.fn();
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={onRedeemed} deps={{ redeem }} />);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /redeem/i }));
    expect(await screen.findByText(/already been used/i)).toBeTruthy();
    expect(onRedeemed).not.toHaveBeenCalled();
  });

  it("RedeemError(code_not_found) → Invalid redemption code", async () => {
    const redeem = vi.fn(async () => { throw new RedeemError("code_not_found", 404); });
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={vi.fn()} deps={{ redeem }} />);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /redeem/i }));
    expect(await screen.findByText(/invalid redemption code/i)).toBeTruthy();
  });

  it("未知错误 → 通用失败文案", async () => {
    const redeem = vi.fn(async () => { throw new Error("network"); });
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={vi.fn()} deps={{ redeem }} />);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /redeem/i }));
    expect(await screen.findByText(/couldn't redeem/i)).toBeTruthy();
  });
});
