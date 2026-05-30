import { it, expect, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { saveAuth, getStoredAuth, clearAuth, isExpiringSoon, getValidJwt, fetchEntitlement, getCachedEntitlement } from "./managed-auth";

beforeEach(() => {
  chromeMock.storage.local.__store = {};
  vi.restoreAllMocks();
});

it("isExpiringSoon true within 5min of expiry", () => {
  const soon = Date.now() + 60_000;
  expect(isExpiringSoon(soon)).toBe(true);
  const later = Date.now() + 30 * 60_000;
  expect(isExpiringSoon(later)).toBe(false);
});

it("getValidJwt refreshes when expiring and persists new tokens", async () => {
  await saveAuth({ jwt: "old", refreshToken: "r1", expiresAt: Date.now() + 1000 });
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ jwt: "new", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const jwt = await getValidJwt();

  expect(jwt).toBe("new");
  expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/refresh$/), expect.objectContaining({ method: "POST" }));
  expect((await getStoredAuth())!.refreshToken).toBe("r2");
});

it("getValidJwt returns existing jwt when not expiring", async () => {
  await saveAuth({ jwt: "fresh", refreshToken: "r1", expiresAt: Date.now() + 30 * 60_000 });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(await getValidJwt()).toBe("fresh");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("fetchEntitlement caches plan + tiers", async () => {
  await saveAuth({ jwt: "fresh", refreshToken: "r1", expiresAt: Date.now() + 30 * 60_000 });
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ plan: "free", tiers: [{ tierId: "default", displayName: "标准" }] }), { status: 200 })));
  const ent = await fetchEntitlement();
  expect(ent.plan).toBe("free");
  expect(ent.tiers).toEqual([{ tierId: "default", displayName: "标准" }]);
  expect(await getCachedEntitlement()).toEqual(ent);
});

it("clearAuth removes stored auth and entitlement", async () => {
  await saveAuth({ jwt: "tok", refreshToken: "rr", expiresAt: Date.now() + 30 * 60_000 });
  // seed entitlement via chrome.storage.local directly (same as fetchEntitlement would)
  chromeMock.storage.local.__store["managed_entitlement"] = { plan: "paid", tiers: [] };
  await clearAuth();
  expect(await getStoredAuth()).toBeNull();
  expect(await getCachedEntitlement()).toBeNull();
});

it("concurrent getValidJwt() with expiring token makes only one refresh request", async () => {
  await saveAuth({ jwt: "old", refreshToken: "r1", expiresAt: Date.now() + 1000 });
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ jwt: "new", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const [jwt1, jwt2] = await Promise.all([getValidJwt(), getValidJwt()]);

  expect(jwt1).toBe("new");
  expect(jwt2).toBe("new");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
