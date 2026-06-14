import { describe, it, expect } from "vitest";
import { ICON_SIZE } from "./tokens";

describe("ICON_SIZE", () => {
  it("exposes the 3-tier icon size scale in px", () => {
    expect(ICON_SIZE.sm).toBe(14);
    expect(ICON_SIZE.md).toBe(16);
    expect(ICON_SIZE.lg).toBe(20);
  });
});
