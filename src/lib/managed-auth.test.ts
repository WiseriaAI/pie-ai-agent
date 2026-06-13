import { describe, expect, it, vi } from "vitest";
import { startManagedLogin } from "./managed-auth";

const redirectUri = "https://abc.chromiumapp.org/";
const deps = (over: Partial<Parameters<typeof startManagedLogin>[0]> = {}) => ({
  getRedirectURL: () => redirectUri,
  launchWebAuthFlow: vi.fn(async () => `${redirectUri}?code=AUTHCODE`),
  fetchFn: vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ apiKey: "sk-virtual", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] } }),
  })) as unknown as typeof fetch,
  ...over,
});

describe("startManagedLogin", () => {
  it("exchanges the code and returns apiKey + entitlement", async () => {
    const d = deps();
    const res = await startManagedLogin(d);
    expect(d.launchWebAuthFlow).toHaveBeenCalledWith({
      url: `https://account.pie.chat/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`,
      interactive: true,
    });
    expect(d.fetchFn).toHaveBeenCalledWith("https://account.pie.chat/auth/exchange", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ code: "AUTHCODE", redirectUri }),
    }));
    expect(res).toEqual({ apiKey: "sk-virtual", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] } });
  });

  it("throws when the user cancels (no code in redirect)", async () => {
    await expect(startManagedLogin(deps({
      launchWebAuthFlow: vi.fn(async () => `${redirectUri}?error=access_denied`),
    }))).rejects.toThrow();
  });

  it("throws when exchange returns non-200", async () => {
    await expect(startManagedLogin(deps({
      fetchFn: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch,
    }))).rejects.toThrow();
  });
});
