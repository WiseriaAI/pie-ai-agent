import { describe, it, expect } from "vitest";
import { enDict } from "../dictionaries/en";
import { zhCNDict } from "../dictionaries/zh-CN";
import { LOCALE_REGISTRY, SUPPORTED_LOCALES } from "../locales";

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

function valueAt(dict: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], dict);
}

describe("dictionary parity", () => {
  it("localizes the general feedback invitation without task-report instructions", () => {
    expect(zhCNDict.settings.feedback.githubHint).toBe(
      "我们非常重视您的意见和建议，欢迎随时向我们反馈"
    );
    expect(enDict.settings.feedback.githubHint).toBe(
      "We greatly value your feedback and suggestions, and welcome you to share them with us anytime."
    );
    expect(zhCNDict.settings.feedback.githubHint).not.toContain("/report-issue");
    expect(enDict.settings.feedback.githubHint).not.toContain("/report-issue");
  });

  it("every registered locale has the same key set as English", () => {
    const enKeys = collectKeys(enDict);
    for (const locale of SUPPORTED_LOCALES) {
      expect(collectKeys(LOCALE_REGISTRY[locale].dictionary), locale).toEqual(enKeys);
    }
  });

  it("every registered dictionary value is a non-empty string", () => {
    const keys = collectKeys(enDict);
    for (const locale of SUPPORTED_LOCALES) {
      for (const path of keys) {
        const v = valueAt(LOCALE_REGISTRY[locale].dictionary, path);
        expect(typeof v, `${locale}: ${path}`).toBe("string");
        expect((v as string).length, `${locale}: ${path}`).toBeGreaterThan(0);
      }
    }
  });

  it("price-card subscribe keys present (en/zh-CN sample)", () => {
    expect(enDict.managed.subscribe.monthly).toBe("Monthly");
    expect(enDict.managed.subscribe.annual).toBe("Yearly");
    expect(enDict.managed.subscribe.pricePerMonthSuffix).toBe("/mo");
    expect(enDict.managed.subscribe.subscribeAnnual).toBe("Subscribe yearly");
    expect(enDict.managed.account.billedYearly).toBe("Billed yearly");
    expect(zhCNDict.managed.subscribe.annualSaveBadge).toBe("省 ~{percent}%");
    expect(zhCNDict.managed.subscribe.subscribeAnnual).toBe("订阅年付");
  });

  it("launch locales translate critical activation labels", () => {
    expect(LOCALE_REGISTRY["es-419"].dictionary.common.cancel).toBe("Cancelar");
    expect(LOCALE_REGISTRY["es-419"].dictionary.common.save).toBe("Guardar");
    expect(LOCALE_REGISTRY.ja.dictionary.common.cancel).toBe("キャンセル");
    expect(LOCALE_REGISTRY.ja.dictionary.common.save).toBe("保存");
    expect(LOCALE_REGISTRY["pt-BR"].dictionary.common.cancel).toBe("Cancelar");
    expect(LOCALE_REGISTRY["pt-BR"].dictionary.common.save).toBe("Salvar");
    expect(LOCALE_REGISTRY["zh-TW"].dictionary.common.cancel).toBe("取消");
    expect(LOCALE_REGISTRY["zh-TW"].dictionary.common.save).toBe("儲存");
  });
});
