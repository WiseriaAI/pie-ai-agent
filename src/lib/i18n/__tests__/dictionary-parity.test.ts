import { describe, it, expect } from "vitest";
import { enDict } from "../dictionaries/en";
import { zhCNDict } from "../dictionaries/zh-CN";

function collectKeys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(path);
    else out.push(...collectKeys(v, path));
  }
  return out.sort();
}

describe("dictionary parity", () => {
  it("en and zh-CN have identical key sets", () => {
    const enKeys = collectKeys(enDict);
    const zhKeys = collectKeys(zhCNDict);
    expect(zhKeys).toEqual(enKeys);
  });

  it("every value in both dictionaries is a non-empty string", () => {
    for (const [dictName, dict] of [
      ["en", enDict],
      ["zh-CN", zhCNDict],
    ] as const) {
      const keys = collectKeys(dict);
      for (const path of keys) {
        const v = path
          .split(".")
          .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], dict);
        expect(typeof v, `${dictName}: ${path}`).toBe("string");
        expect((v as string).length, `${dictName}: ${path}`).toBeGreaterThan(0);
      }
    }
  });
});
