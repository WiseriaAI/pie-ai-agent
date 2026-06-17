import { describe, it, expect, beforeEach } from "vitest";
import { runStartupMigrations, _resetStartupMigrationsForTests } from "./startup-migrations";
import { setConfig } from "./idb/config-store";
import { _resetForTests } from "./idb/db";
import { getCachedEntitlement, _clearEntitlementCacheForTests } from "./managed-account";

describe("runStartupMigrations — entitlement 水合", () => {
  beforeEach(async () => {
    await _resetForTests();
    _resetStartupMigrationsForTests();
    _clearEntitlementCacheForTests();
  });

  it("把持久化的 managed entitlement 灌回内存缓存", async () => {
    await setConfig("managed_entitlement_sk-boot", {
      plan: "active", email: "b@x.com", subscription: null, quota: null,
      models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 }],
    });
    _clearEntitlementCacheForTests();
    expect(getCachedEntitlement("sk-boot")).toBeNull();
    await runStartupMigrations();
    expect(getCachedEntitlement("sk-boot")?.email).toBe("b@x.com");
  });
});
