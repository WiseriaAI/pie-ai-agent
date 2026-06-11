import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE, GATEWAY_BASE } from "./managed-config";

describe("managed-config", () => {
  it("exposes the official account + gateway base URLs without trailing slash", () => {
    expect(ACCOUNT_BASE).toBe("https://account.pie.chat");
    expect(GATEWAY_BASE).toBe("https://api.pie.chat");
    expect(ACCOUNT_BASE.endsWith("/")).toBe(false);
    expect(GATEWAY_BASE.endsWith("/")).toBe(false);
  });
});
