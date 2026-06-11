import { describe, expect, it, vi } from "vitest";
import { getEntitlement, openCheckout, openPortal } from "./managed-account";

describe("managed-account", () => {
  it("getEntitlement GETs /me/entitlement with Bearer and parses", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ plan: "active", email: "u@x.com", budgetRemainingUsd: 5.5 }),
    })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-virtual", { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/me/entitlement", {
      headers: { authorization: "Bearer sk-virtual" },
    });
    expect(res).toEqual({ plan: "active", email: "u@x.com", budgetRemainingUsd: 5.5 });
  });

  it("openCheckout POSTs /billing/checkout and opens the returned url", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ url: "https://checkout.test/x" }) })) as unknown as typeof fetch;
    const openTab = vi.fn();
    await openCheckout("sk-virtual", { fetchFn, openTab });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/billing/checkout", {
      method: "POST", headers: { authorization: "Bearer sk-virtual" },
    });
    expect(openTab).toHaveBeenCalledWith("https://checkout.test/x");
  });

  it("openPortal POSTs /billing/portal and opens the returned url", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ url: "https://portal.test/y" }) })) as unknown as typeof fetch;
    const openTab = vi.fn();
    await openPortal("sk-virtual", { fetchFn, openTab });
    expect(openTab).toHaveBeenCalledWith("https://portal.test/y");
  });
});
