import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ManagedLoginCard } from "./ManagedLoginCard";
import * as auth from "@/lib/managed-auth";
import * as instances from "@/lib/instances";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ManagedLoginCard", () => {
  it("renders a login button", () => {
    render(<ManagedLoginCard onDone={() => {}} />);
    expect(screen.getByRole("button", { name: /Google|登录|官方服务|免.*key/i })).toBeTruthy();
  });

  it("login → creates managed instance, sets active, calls onDone", async () => {
    vi.spyOn(auth, "loginWithOAuth").mockResolvedValue({
      plan: "free",
      tiers: [{ tierId: "default", displayName: "标准" }],
    });
    vi.spyOn(auth, "getStoredAuth").mockResolvedValue({
      jwt: "test-jwt",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    const createSpy = vi.spyOn(instances, "createManagedInstance").mockResolvedValue("inst-1");
    const setActiveSpy = vi.spyOn(instances, "setActiveInstance").mockResolvedValue(undefined);
    const onDone = vi.fn();

    render(<ManagedLoginCard onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /Google|登录/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith("test-jwt", "default");
    expect(setActiveSpy).toHaveBeenCalledWith("inst-1");
    expect(onDone).toHaveBeenCalledWith("inst-1");
  });

  it("shows error message when login fails", async () => {
    vi.spyOn(auth, "loginWithOAuth").mockRejectedValue(new Error("网络错误"));
    const onDone = vi.fn();

    render(<ManagedLoginCard onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /Google|登录/i }));

    await waitFor(() => expect(screen.getByText(/网络错误/)).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });

  it("shows busy state while logging in", async () => {
    let resolveLogin!: (v: auth.Entitlement) => void;
    vi.spyOn(auth, "loginWithOAuth").mockReturnValue(
      new Promise<auth.Entitlement>((res) => { resolveLogin = res; }),
    );

    render(<ManagedLoginCard onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Google|登录/i }));

    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);

    // cleanup: resolve the promise to avoid unhandled rejection
    resolveLogin({ plan: "free", tiers: [] });
  });
});
