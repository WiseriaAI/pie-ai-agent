import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { setProviderCustomModelMeta } from "@/lib/provider-custom-model-meta";
import { resolveSupportsVision } from "./chat-vision";

beforeEach(() => { chromeMock.storage.local.__store = {}; });

describe("resolveSupportsVision", () => {
  it("builtin custom model vision: pcmm vision unlocks supportsVision", async () => {
    await setProviderCustomModelMeta("minimax", "MiniMax-Future", { vision: true, maxContextTokens: 256_000 });
    expect(await resolveSupportsVision("minimax", "MiniMax-Future", undefined)).toBe(true);
  });

  it("pcmm hit with vision:false → false (explicit, not unknown)", async () => {
    await setProviderCustomModelMeta("minimax", "TextOnly", { vision: false, maxContextTokens: 256_000 });
    expect(await resolveSupportsVision("minimax", "TextOnly", undefined)).toBe(false);
  });

  it("registry preset wins (MiniMax-M3 vision true) without any pcmm", async () => {
    expect(await resolveSupportsVision("minimax", "MiniMax-M3", undefined)).toBe(true);
  });

  it("registry no-vision model stays false (MiniMax-M2)", async () => {
    expect(await resolveSupportsVision("minimax", "MiniMax-M2", undefined)).toBe(false);
  });

  it("fetched catalog vision unlocks supportsVision (openrouter lazy models)", async () => {
    const fetched = [{ id: "google/gemini-2.0-flash", vision: true, tools: true, maxContextTokens: 1_000_000 }];
    expect(await resolveSupportsVision("openrouter", "google/gemini-2.0-flash", fetched)).toBe(true);
  });

  it("unknown id, no pcmm, no fetched → false (fail-closed)", async () => {
    expect(await resolveSupportsVision("minimax", "totally-unknown", undefined)).toBe(false);
  });
});
