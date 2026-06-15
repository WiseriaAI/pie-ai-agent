import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import type { LoginResult } from "@/lib/managed-auth";
import ManagedSubscribePanel from "./ManagedSubscribePanel";

afterEach(() => {
  cleanup();
});

describe("ManagedSubscribePanel", () => {
  it("already-active login creates the config immediately", async () => {
    const onCreated = vi.fn();
    render(<ManagedSubscribePanel
      onCreated={onCreated}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 200000, costLevel: 1 }] } })),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sk-v", "u@x.com"));
  });

  it("non-subscribed login shows a Subscribe button (does not create yet)", async () => {
    const onCreated = vi.fn();
    render(<ManagedSubscribePanel
      onCreated={onCreated}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("auto-polls after checkout and calls onCreated when plan becomes active (no manual refresh needed)", async () => {
    const onCreated = vi.fn();

    // refresh returns "none" on 1st call, "active" on 2nd call
    let refreshCallCount = 0;
    const refresh = vi.fn(async (): Promise<LoginResult["entitlement"]> => {
      refreshCallCount++;
      if (refreshCallCount >= 2) {
        return { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 200000, costLevel: 1 }] };
      }
      return { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] };
    });

    render(
      <ManagedSubscribePanel
        onCreated={onCreated}
        pollIntervalMs={10}
        deps={{
          login: vi.fn(async (): Promise<LoginResult> => ({
            apiKey: "sk-v",
            entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] },
          })),
          checkout: vi.fn(async () => {}),
          refresh,
        }}
      />,
    );

    // Log in first
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    // Wait for Subscribe button to appear
    await screen.findByRole("button", { name: /subscribe/i });
    expect(onCreated).not.toHaveBeenCalled();

    // Click Subscribe — this triggers checkout and starts auto-polling
    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));

    // Wait for onCreated to be called automatically — no manual button click
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sk-v", "u@x.com"), {
      timeout: 2000,
    });

    // Confirm refresh was called (polling happened)
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("shows polling indicator while waiting for payment confirmation", async () => {
    const onCreated = vi.fn();
    // refresh never returns "active" during this test
    const refresh = vi.fn(async (): Promise<LoginResult["entitlement"]> => ({
      plan: "none",
      email: "u@x.com",
      subscription: null,
      quota: null,
      models: [],
    }));

    render(
      <ManagedSubscribePanel
        onCreated={onCreated}
        pollIntervalMs={10000} // long interval so polling doesn't fire during this test
        deps={{
          login: vi.fn(async (): Promise<LoginResult> => ({
            apiKey: "sk-v",
            entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] },
          })),
          checkout: vi.fn(async () => {}),
          refresh,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });

    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));

    // Polling indicator should appear
    await waitFor(() => {
      expect(screen.getByText(/waiting for payment confirmation/i)).toBeTruthy();
    });
  });

  it("eligible（introOffer 在场）→ 登录后显示首月半价徽标", async () => {
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], introOffer: { percentOff: 50 } } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(screen.getByText(/first month 50% off/i)).toBeTruthy();
  });

  it("非 eligible（无 introOffer）→ 不显示徽标", async () => {
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(screen.queryByText(/first month/i)).toBeNull();
  });

  it("blocked 用户即便误带 introOffer 也不显示徽标（客户端自我设防：徽标只属 plan:none）", async () => {
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "blocked", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: null, models: [], introOffer: { percentOff: 50 } } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(screen.queryByText(/first month/i)).toBeNull();
  });

  it("登录后（plan:none）显示兑换输入框；兑换成功转 active → onCreated", async () => {
    const login = vi.fn(async (): Promise<LoginResult> => ({
      apiKey: "sk-v",
      entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] },
    }));
    const activeEnt = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" as const }, quota: null, models: [] };
    const redeem = vi.fn(async () => activeEnt);
    const onCreated = vi.fn();
    render(<ManagedSubscribePanel onCreated={onCreated} deps={{ login, checkout: vi.fn(async () => {}), redeem }} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /^subscribe$/i });
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "PIE-AAAAA-BBBBB-CCCCC" } });
    fireEvent.click(screen.getByRole("button", { name: /^redeem$/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sk-v", "u@x.com"));
  });

  it("does not call onCreated after unmount (cleanup works)", async () => {
    const onCreated = vi.fn();

    // refresh will resolve "active" after a delay, but we'll unmount first
    const refresh = vi.fn(
      (): Promise<LoginResult["entitlement"]> =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 200000, costLevel: 1 }] }),
            200,
          ),
        ),
    );

    const { unmount } = render(
      <ManagedSubscribePanel
        onCreated={onCreated}
        pollIntervalMs={50}
        deps={{
          login: vi.fn(async (): Promise<LoginResult> => ({
            apiKey: "sk-v",
            entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] },
          })),
          checkout: vi.fn(async () => {}),
          refresh,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));

    // Wait for polling to start (indicator appears)
    await waitFor(() =>
      expect(screen.getByText(/waiting for payment confirmation/i)).toBeTruthy(),
    );

    // Unmount before the "active" response comes back
    act(() => {
      unmount();
    });

    // Give enough time for the pending promise to resolve
    await new Promise((r) => setTimeout(r, 400));

    // onCreated must NOT have been called
    expect(onCreated).not.toHaveBeenCalled();
  });
});
