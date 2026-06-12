import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { resolveLocale, normalizeBrowserLocale } from "../locale-resolver";
import { SUPPORTED_LOCALES, LOCALE_REGISTRY } from "../locales";
import { enDict } from "../dictionaries/en";
import { zhCNDict } from "../dictionaries/zh-CN";
import { STORAGE_KEY_ASSISTANT_LANGUAGE } from "../index";
import { STORAGE_KEY_UI_LOCALE } from "../types";
import { setConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";

describe("locale registry", () => {
  it("registers all launch locales in stable order", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh-CN", "es-419", "ja", "pt-BR"]);
  });

  it("maps app locales to Chrome locale folder ids", () => {
    expect(LOCALE_REGISTRY["es-419"].chromeLocale).toBe("es_419");
    expect(LOCALE_REGISTRY.ja.chromeLocale).toBe("ja");
    expect(LOCALE_REGISTRY["pt-BR"].chromeLocale).toBe("pt_BR");
  });

  it("marks every launch locale as ltr in this release", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_REGISTRY[locale].dir).toBe("ltr");
    }
  });

  it("maps launch locales to their current dictionaries", () => {
    expect(LOCALE_REGISTRY.en.dictionary).toBe(enDict);
    expect(LOCALE_REGISTRY["zh-CN"].dictionary).toBe(zhCNDict);
    expect(LOCALE_REGISTRY["es-419"].dictionary).toBe(enDict);
    expect(LOCALE_REGISTRY.ja.dictionary).toBe(enDict);
    expect(LOCALE_REGISTRY["pt-BR"].dictionary).toBe(enDict);
  });

  it("exports assistant language settings through the i18n barrel", () => {
    expect(STORAGE_KEY_ASSISTANT_LANGUAGE).toBe("assistant_language");
  });
});

describe("normalizeBrowserLocale", () => {
  it("zh-CN → zh-CN", () => {
    expect(normalizeBrowserLocale("zh-CN")).toBe("zh-CN");
  });
  it("zh-TW → zh-CN (any zh* maps to zh-CN — v1 only ships Simplified)", () => {
    expect(normalizeBrowserLocale("zh-TW")).toBe("zh-CN");
  });
  it("zh-Hans → zh-CN", () => {
    expect(normalizeBrowserLocale("zh-Hans")).toBe("zh-CN");
  });
  it("en-US → en", () => {
    expect(normalizeBrowserLocale("en-US")).toBe("en");
  });
  it("fr-FR → en (unsupported falls back)", () => {
    expect(normalizeBrowserLocale("fr-FR")).toBe("en");
  });
  it("empty string → en", () => {
    expect(normalizeBrowserLocale("")).toBe("en");
  });
});

describe("resolveLocale", () => {
  beforeEach(async () => {
    await _resetForTests();
    chromeMock.i18n.__uiLanguage = "en";
  });

  it("returns 'en' when storage override is 'en'", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "en");
    expect(await resolveLocale()).toBe("en");
  });

  it("returns 'zh-CN' when storage override is 'zh-CN'", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "zh-CN");
    expect(await resolveLocale()).toBe("zh-CN");
  });

  it("falls back to chrome.i18n when override is 'auto'", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "auto");
    chromeMock.i18n.__uiLanguage = "zh-CN";
    expect(await resolveLocale()).toBe("zh-CN");
  });

  it("falls back to chrome.i18n when storage is empty", async () => {
    chromeMock.i18n.__uiLanguage = "zh-TW";
    expect(await resolveLocale()).toBe("zh-CN");
  });

  it("falls back to 'en' when chrome.i18n returns unsupported locale", async () => {
    chromeMock.i18n.__uiLanguage = "fr-FR";
    expect(await resolveLocale()).toBe("en");
  });

  it("ignores garbage values in storage override and falls through to chrome.i18n", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "klingon");
    chromeMock.i18n.__uiLanguage = "zh-CN";
    expect(await resolveLocale()).toBe("zh-CN");
  });
});
