import { describe, it, expect, afterEach } from "vitest";
import { queryGrants, revokeGrant } from "./local-grants";
import { chromeMock } from "@/test/setup";

const GRANT = {
  key: "skill:s:abc",
  skillName: "fetch-report",
  envelope: { allowedDomains: [], extraWrites: [], runnableScripts: ["fetch.ts"] },
  grantedAt: 1700000000000,
};

afterEach(() => chromeMock.runtime.sendMessage.mockReset());

describe("local-grants helpers", () => {
  it("queryGrants resolves the grants array", async () => {
    chromeMock.runtime.sendMessage.mockImplementation(((_m: unknown, cb?: (r: unknown) => void) => {
      cb?.({ grants: [GRANT] });
      return Promise.resolve();
    }) as typeof chromeMock.runtime.sendMessage);
    expect(await queryGrants()).toEqual([GRANT]);
  });

  it("queryGrants resolves [] on error / malformed response", async () => {
    chromeMock.runtime.sendMessage.mockImplementation((() => {
      throw new Error("no SW");
    }) as unknown as typeof chromeMock.runtime.sendMessage);
    expect(await queryGrants()).toEqual([]);
  });

  it("revokeGrant sends key and resolves ok", async () => {
    let sent: Record<string, unknown> | null = null;
    chromeMock.runtime.sendMessage.mockImplementation(((m: Record<string, unknown>, cb?: (r: unknown) => void) => {
      sent = m;
      cb?.({ ok: true });
      return Promise.resolve();
    }) as typeof chromeMock.runtime.sendMessage);
    expect(await revokeGrant("skill:s:abc")).toBe(true);
    expect(sent).toEqual({ type: "local-grants:revoke", key: "skill:s:abc" });
  });
});
