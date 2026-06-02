import { describe, it, expect } from "vitest";
import { providerDisplayName } from "./provider-display-name";
import { enDict } from "./dictionaries/en";
import { zhCNDict } from "./dictionaries/zh-CN";
import type { DictKey } from "./use-t";

// Stub t() that echoes the dict key, so we can assert WHICH key a provider
// routes to (i.e. that it goes through localization at all) without coupling
// the test to the dictionary's current string values.
const echoT = (key: DictKey): string => key;

describe("providerDisplayName — Moonshot dual-region", () => {
  it("moonshot-cn routes through the i18n dictionary (locale-dependent China suffix)", () => {
    expect(
      providerDisplayName({ id: "moonshot-cn", name: "Moonshot(Kimi) China" }, echoT),
    ).toBe("providers.moonshotCn");
  });

  it("international moonshot falls back to its registry name (locale-neutral)", () => {
    expect(providerDisplayName({ id: "moonshot", name: "Moonshot(Kimi)" }, echoT)).toBe(
      "Moonshot(Kimi)",
    );
  });

  it("dictionary carries the localized China names (en / zh-CN)", () => {
    expect(enDict.providers.moonshotCn).toBe("Moonshot(Kimi) China");
    expect(zhCNDict.providers.moonshotCn).toBe("Moonshot(Kimi) 中国区");
  });
});
