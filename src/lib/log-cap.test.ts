import { describe, expect, it } from "vitest";
import { capLogBytes } from "./log-cap";

describe("capLogBytes", () => {
  it("returns short ASCII strings unchanged", () => {
    const s = "hello world";
    expect(capLogBytes(s, 150_000)).toBe(s);
  });

  it("caps long CJK strings within the byte budget with no trailing replacement char", () => {
    const s = "日".repeat(100_000);
    const capped = capLogBytes(s, 150_000);
    const byteLen = new TextEncoder().encode(capped).length;
    expect(byteLen).toBeLessThanOrEqual(150_000);
    expect(capped.endsWith("�")).toBe(false);
  });
});
