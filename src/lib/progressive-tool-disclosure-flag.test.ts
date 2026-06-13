import { describe, expect, it, vi, beforeEach } from "vitest";

const store = new Map<string, unknown>();
vi.mock("@/lib/idb/config-store", () => ({
  getConfig: vi.fn(async (k: string) => store.get(k)),
  setConfig: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
  removeConfig: vi.fn(async (k: string) => { store.delete(k); }),
}));

import {
  getProgressiveDisclosureFlag,
  setProgressiveDisclosureFlag,
  PROGRESSIVE_TOOL_DISCLOSURE_KEY,
} from "./progressive-tool-disclosure-flag";

beforeEach(() => store.clear());

describe("progressiveToolDisclosure flag", () => {
  it("defaults to true (on) when unset", async () => {
    expect(await getProgressiveDisclosureFlag()).toBe(true);
  });
  it("round-trips false", async () => {
    await setProgressiveDisclosureFlag(false);
    expect(await getProgressiveDisclosureFlag()).toBe(false);
  });
  it("round-trips true", async () => {
    await setProgressiveDisclosureFlag(false);
    await setProgressiveDisclosureFlag(true);
    expect(await getProgressiveDisclosureFlag()).toBe(true);
  });
  it("uses the documented storage key", () => {
    expect(PROGRESSIVE_TOOL_DISCLOSURE_KEY).toBe("progressive_tool_disclosure");
  });
});
