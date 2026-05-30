import { describe, it, expect } from "vitest";
import { dispatchStreamChat, streamChatByProvider } from "@/lib/model-router/providers";
import { getProviderMeta } from "@/lib/model-router/providers/registry";
import { streamChat as managedChat } from "@/lib/model-router/providers/managed";

it("registry exposes managed with fixed Supabase baseUrl and two tiers", () => {
  const meta = getProviderMeta("managed");
  expect(meta).toBeDefined();
  expect(meta!.defaultBaseUrl).toMatch(/\/functions\/v1$/);
  expect(meta!.models.map((m) => m.id)).toEqual(["default", "advanced"]);
});

it("dispatch routes managed to the managed wrapper via streamChatByProvider", () => {
  expect(streamChatByProvider.managed).toBe(managedChat);
});

it("dispatchStreamChat returns managed wrapper for managed provider config", () => {
  const fn = dispatchStreamChat({ provider: "managed", model: "default", apiKey: "jwt" });
  expect(fn).toBe(managedChat);
});
