import { describe, expect, it } from "vitest";
import { quotaTier, formatDate, formatResetDate, consumptionDots, formatMoney, TIER_FILL_CLASS, TIER_TEXT_CLASS } from "./managed-format";

describe("managed-format", () => {
  it("quotaTier 边界：<0.80 neutral / [0.80,0.95) caution / >=0.95 critical", () => {
    expect(quotaTier(0)).toBe("neutral");
    expect(quotaTier(0.79)).toBe("neutral");
    expect(quotaTier(0.8)).toBe("caution");
    expect(quotaTier(0.94)).toBe("caution");
    expect(quotaTier(0.95)).toBe("critical");
    expect(quotaTier(1)).toBe("critical");
  });

  it("档位 class 映射齐全", () => {
    expect(TIER_FILL_CLASS.neutral).toBe("bg-fg-1");
    expect(TIER_FILL_CLASS.caution).toBe("bg-pending");
    expect(TIER_FILL_CLASS.critical).toBe("bg-warning");
    expect(TIER_TEXT_CLASS.neutral).toBe("text-fg-1");
    expect(TIER_TEXT_CLASS.caution).toBe("text-pending");
    expect(TIER_TEXT_CLASS.critical).toBe("text-warning");
  });

  it("formatDate：unix 秒 → 'Mon DD, YYYY'，null/非有限 → null", () => {
    expect(formatDate(1750000000)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeNull();
    expect(formatDate(Number.NaN)).toBeNull();
  });

  it("formatResetDate：unix 秒 → 'Ddd, Mon DD'，null → null", () => {
    expect(formatResetDate(1750400000)).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
    expect(formatResetDate(null)).toBeNull();
  });

  it("formatMoney：USD 599 → 带货币码 USD 5.99（两位小数）", () => {
    expect(formatMoney(599, "usd", "en")).toMatch(/USD\s*5\.99/);
    expect(formatMoney(599, "usd", "en")).not.toMatch(/\$/); // 不显示裸符号
  });
  it("formatMoney：USD 6200 → USD 62.00", () => {
    expect(formatMoney(6200, "usd", "en")).toMatch(/USD\s*62\.00/);
  });
  it("formatMoney：JPY 500 → 零小数货币按小数位换算（不写死 /100）", () => {
    // JPY maximumFractionDigits=0 → 500/1=500，不是 5
    expect(formatMoney(500, "jpy", "en")).toMatch(/JPY\s*500/);
    expect(formatMoney(500, "jpy", "en")).not.toMatch(/5\.00/);
  });
  it("formatMoney：locale 影响小数分隔符（de → 逗号）", () => {
    expect(formatMoney(599, "usd", "de")).toMatch(/5,99/);
  });
});

describe("consumptionDots", () => {
  it("costLevel → 3 个布尔（实心数 = level）", () => {
    expect(consumptionDots(1)).toEqual([true, false, false]);
    expect(consumptionDots(2)).toEqual([true, true, false]);
    expect(consumptionDots(3)).toEqual([true, true, true]);
  });
  it("越界值收敛到 1..3", () => {
    expect(consumptionDots(0)).toEqual([true, false, false]);
    expect(consumptionDots(9)).toEqual([true, true, true]);
  });
});
