import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getCachedEntitlement, getEntitlement, openCheckout, openPortal,
  cachedManagedModel, redeem, RedeemError,
  hydrateEntitlementCache, _clearEntitlementCacheForTests,
} from "./managed-account";
import { getConfig, setConfig } from "./idb/config-store";
import { _resetForTests } from "./idb/db";

describe("managed-account", () => {
  it("getEntitlement GETs /me/entitlement?locale= with Bearer and parses v2.1", async () => {
    const v2 = {
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe" },
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

  it("normalizeEntitlement 给 subscription 补 source 默认 stripe（后端漏发时）", async () => {
    const raw = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1, cancelAtPeriodEnd: false }, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-src1", { fetchFn, locale: "en" });
    expect(res.subscription).toEqual({ planName: "Pie Pro", currentPeriodEnd: 1, cancelAtPeriodEnd: false, source: "stripe" });
  });

  it("normalizeEntitlement 透传 source=redemption + cancelAtPeriodEnd", async () => {
    const raw = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" }, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-src2", { fetchFn, locale: "en" });
    expect(res.subscription).toMatchObject({ source: "redemption", cancelAtPeriodEnd: true });
  });

  it("redeem POSTs /redeem?locale= with Bearer + {code}, 解析并缓存 entitlement", async () => {
    const ent = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" }, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    const res = await redeem("sk-r", "PIE-AAAAA-BBBBB-CCCCC", { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/redeem?locale=en", {
      method: "POST",
      headers: { authorization: "Bearer sk-r", "content-type": "application/json" },
      body: JSON.stringify({ code: "PIE-AAAAA-BBBBB-CCCCC" }),
    });
    expect(res.subscription?.source).toBe("redemption");
    expect(getCachedEntitlement("sk-r")).toEqual(res);
  });

  it("redeem 非 2xx → 抛 RedeemError 带后端 error code 与 status", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "code_already_redeemed" }) })) as unknown as typeof fetch;
    await expect(redeem("sk-r2", "X", { fetchFn })).rejects.toMatchObject({ code: "code_already_redeemed", status: 409 });
  });

  it("redeem 错误体不可解析 → RedeemError code=redeem_failed", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error("no json"); } })) as unknown as typeof fetch;
    await expect(redeem("sk-r3", "X", { fetchFn })).rejects.toMatchObject({ code: "redeem_failed", status: 500 });
  });
});

describe("managed-account persistence", () => {
  beforeEach(async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
  });

  it("getEntitlement 双写：内存 + IDB(config managed_entitlement_<apiKey>)", async () => {
    const ent = { plan: "active", email: "p@x.com", subscription: null, quota: null,
      models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 }] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-persist", { fetchFn, locale: "en" });
    expect(await getConfig("managed_entitlement_sk-persist")).toEqual(res);
  });

  it("hydrateEntitlementCache：IDB → 内存（normalizeEntitlement 归一化残缺结构）", async () => {
    await setConfig("managed_entitlement_sk-hyd", { email: "h@x.com" }); // 残缺/旧结构
    _clearEntitlementCacheForTests();
    expect(getCachedEntitlement("sk-hyd")).toBeNull();
    await hydrateEntitlementCache();
    expect(getCachedEntitlement("sk-hyd")).toEqual({
      plan: "none", email: "h@x.com", subscription: null, quota: null, models: [],
    });
  });

  it("redeem 双写 IDB", async () => {
    const ent = { plan: "active", email: "r@x.com",
      subscription: { planName: "Pie", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" },
      quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    const res = await redeem("sk-rp", "CODE", { fetchFn, locale: "en" });
    expect(await getConfig("managed_entitlement_sk-rp")).toEqual(res);
  });
});
