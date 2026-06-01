import { describe, it, expect } from "vitest";
import { scrubHar } from "./har-scrub";
import type { Har } from "./types";

const sampleHar = (): Har => ({
  log: {
    entries: [
      { request: { url: "https://api.anthropic.com/v1/messages", headers: [{ name: "Authorization", value: "Bearer sk-secret" }] }, response: { headers: [] } },
      { request: { url: "https://shop.webarena.local/cart", headers: [{ name: "Cookie", value: "session=abc" }, { name: "Accept", value: "*/*" }] }, response: { headers: [{ name: "Set-Cookie", value: "x=y" }] } },
    ],
  },
});

describe("scrubHar", () => {
  it("drops entries whose host is not in the allow-list (removes the BYOK-key-bearing provider call)", () => {
    const out = scrubHar(sampleHar(), ["shop.webarena.local"]);
    expect(out.log.entries).toHaveLength(1);
    expect(out.log.entries[0].request.url).toContain("shop.webarena.local");
    expect(JSON.stringify(out)).not.toContain("sk-secret");
  });

  it("strips sensitive headers from kept entries", () => {
    const out = scrubHar(sampleHar(), ["shop.webarena.local"]);
    const reqHeaderNames = out.log.entries[0].request.headers.map((h) => h.name.toLowerCase());
    expect(reqHeaderNames).not.toContain("cookie");
    expect(reqHeaderNames).toContain("accept");
    const resHeaderNames = out.log.entries[0].response.headers.map((h) => h.name.toLowerCase());
    expect(resHeaderNames).not.toContain("set-cookie");
  });

  it("does not mutate the input", () => {
    const input = sampleHar();
    scrubHar(input, ["shop.webarena.local"]);
    expect(input.log.entries).toHaveLength(2);
  });
});
