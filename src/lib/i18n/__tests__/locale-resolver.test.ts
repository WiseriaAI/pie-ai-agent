import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { resolveLocale, normalizeBrowserLocale } from "../locale-resolver";

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
  beforeEach(() => {
    chromeMock.i18n.__uiLanguage = "en";
  });

  it("returns 'en' when storage override is 'en'", async () => {
    await chromeMock.storage.local.set({ ui_locale: "en" });
    expect(await resolveLocale()).toBe("en");
  });

  it("returns 'zh-CN' when storage override is 'zh-CN'", async () => {
    await chromeMock.storage.local.set({ ui_locale: "zh-CN" });
    expect(await resolveLocale()).toBe("zh-CN");
  });

  it("falls back to chrome.i18n when override is 'auto'", async () => {
    await chromeMock.storage.local.set({ ui_locale: "auto" });
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
    await chromeMock.storage.local.set({ ui_locale: "klingon" });
    chromeMock.i18n.__uiLanguage = "zh-CN";
    expect(await resolveLocale()).toBe("zh-CN");
  });
});
