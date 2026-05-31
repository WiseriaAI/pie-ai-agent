import { it, expect, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { streamChat } from "./managed";
import { saveAuth } from "@/lib/managed-auth";
import type { ModelConfig } from "@/lib/model-router";

const cfg: ModelConfig = { provider: "managed", model: "default", apiKey: "old-jwt", baseUrl: "https://x.test/functions/v1" };
beforeEach(() => { chromeMock.storage.local.__store = {}; vi.restoreAllMocks(); });

it("on 401 refreshes token once and retries, then succeeds", async () => {
  await saveAuth({ jwt: "old-jwt", refreshToken: "r1", expiresAt: Date.now() + 30 * 60_000 });
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth-refresh"))
      return new Response(JSON.stringify({ jwt: "new-jwt", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }), { status: 200 });
    call++;
    if (call === 1) return new Response("", { status: 401 });
    return new Response("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } });
  }));

  const events = [];
  for await (const e of streamChat(cfg, [{ role: "user", content: "hi" }])) events.push(e);

  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.some((e) => e.type === "done")).toBe(true);
  expect(call).toBe(2); // retried once
});

it("on persistent 401 surfaces error (no infinite retry)", async () => {
  await saveAuth({ jwt: "old-jwt", refreshToken: "r1", expiresAt: Date.now() + 30 * 60_000 });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth-refresh"))
      return new Response(JSON.stringify({ jwt: "new-jwt", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }), { status: 200 });
    return new Response("", { status: 401 });
  }));
  const events = [];
  for await (const e of streamChat(cfg, [{ role: "user", content: "hi" }])) events.push(e);
  expect(events.filter((e) => e.type === "error" && e.status === 401).length).toBe(1);
});
