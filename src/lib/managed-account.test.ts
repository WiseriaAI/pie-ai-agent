import { describe, expect, it, vi } from "vitest";
import { getCachedEntitlement, getEntitlement, openCheckout, openPortal, cachedManagedModel } from "./managed-account";

describe("managed-account", () => {
  it("getEntitlement GETs /me/entitlement?locale= with Bearer and parses v2.1", async () => {
    const v2 = {
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false },
      quota: { weekly: { usedFraction: 0.5, resetAt: 1750400000 } },
      models: [{ id: "default", name: "标准", description: "快", vision: false, maxContextTokens: 128000, costLevel: 1 }],
    };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => v2 })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-virtual", { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/me/entitlement?locale=en", {
      headers: { authorization: "Bearer sk-virtual" },
    });
    expect(res).toEqual(v2);
  });

  it("normalizeEntitlement 容忍缺字段：plan 落 none、数组/对象补默认", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ email: "u@x.com" }) })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-virtual", { fetchFn, locale: "en" });
    expect(res).toEqual({ plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] });
  });

  it("normalizeEntitlement 给每个模型补 vision/maxContextTokens/costLevel 默认", async () => {
    const raw = { plan: "active", email: "u@x.com", subscription: null, quota: null,
      models: [{ id: "pro", name: "进阶" }, { id: "x", name: "X", vision: true, maxContextTokens: 200000, costLevel: 3, description: "d" }] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-n", { fetchFn, locale: "en" });
    expect(res.models).toEqual([
      { id: "pro", name: "进阶", vision: false, maxContextTokens: 128000, costLevel: 1 },
      { id: "x", name: "X", description: "d", vision: true, maxContextTokens: 200000, costLevel: 3 },
    ]);
  });

  it("getEntitlement 写入进程内缓存，getCachedEntitlement 可读回", async () => {
    expect(getCachedEntitlement("sk-cache")).toBeNull();
    const v2 = { plan: "active", email: "c@x.com", subscription: null, quota: { weekly: { usedFraction: 0.3, resetAt: 1750400000 } }, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => v2 })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-cache", { fetchFn });
    expect(getCachedEntitlement("sk-cache")).toEqual(res);
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

  it("cachedManagedModel 按 id 命中缓存模型，未命中/无缓存返回 undefined", async () => {
    const raw = { plan: "active", email: "e", subscription: null, quota: null,
      models: [{ id: "pro", name: "进阶", vision: true, maxContextTokens: 200000, costLevel: 3 }] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    await getEntitlement("sk-cm", { fetchFn, locale: "en" });
    expect(cachedManagedModel("sk-cm", "pro")).toEqual({ id: "pro", name: "进阶", vision: true, maxContextTokens: 200000, costLevel: 3 });
    expect(cachedManagedModel("sk-cm", "nope")).toBeUndefined();
    expect(cachedManagedModel("sk-absent", "pro")).toBeUndefined();
  });

  it("normalizeEntitlement 透传合法 introOffer", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], introOffer: { percentOff: 50 } };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-io1", { fetchFn, locale: "en" });
    expect(res.introOffer).toEqual({ percentOff: 50 });
  });

  it("normalizeEntitlement 无 introOffer 时字段缺省（不强填）", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-io2", { fetchFn, locale: "en" });
    expect(res.introOffer).toBeUndefined();
  });

  it("normalizeEntitlement 丢弃畸形 introOffer（percentOff 非数字）", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], introOffer: { percentOff: "x" } };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-io3", { fetchFn, locale: "en" });
    expect(res.introOffer).toBeUndefined();
  });

  it.each([0, -10, NaN])("normalizeEntitlement 丢弃 percentOff 非正数/NaN: %s", async (percentOff) => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], introOffer: { percentOff } };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement(`sk-io-${percentOff}`, { fetchFn, locale: "en" });
    expect(res.introOffer).toBeUndefined();
  });

  it("normalizeEntitlement 信任后端：>100/小数 原样透传（客户端只显示不算价、不 clamp）", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], introOffer: { percentOff: 50.5 } };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-io-frac", { fetchFn, locale: "en" });
    expect(res.introOffer).toEqual({ percentOff: 50.5 });
  });
});
