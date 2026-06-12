import { describe, expect, it } from "vitest";
import { streamChatByProvider } from "./index";
import { getProviderMeta } from "./registry";

describe("managed provider registration", () => {
  it("dispatches managed through the OpenAI-compat core", () => {
    expect(typeof streamChatByProvider.managed).toBe("function");
  });
  it("registry has managed with a single 'default' tier alias and the gateway base", () => {
    const meta = getProviderMeta("managed");
    expect(meta).toBeDefined();
    expect(meta!.defaultBaseUrl).toBe("https://api.pie.chat");
    expect(meta!.models.map((m) => m.id)).toEqual(["default"]);
    expect(meta!.models[0]!.tools).toBe(true);
  });
});
