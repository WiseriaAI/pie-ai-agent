import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { streamChat, type ModelConfig } from ".";
import type { StreamEvent } from "./types";
import { _resetForTests } from "./rate-limiter";

// mock dispatch 层：每次调用产出一个 text-delta + done
vi.mock("./providers", () => ({
  dispatchStreamChat: vi.fn(() =>
    async function* () {
      yield { type: "text-delta", text: "ok" };
      yield { type: "done", stopReason: "end" };
    },
  ),
}));
// streamChat 前置的 resolveProviderMeta 需要 registry 正常工作（openai 是 builtin）
const config = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  provider: "openai",
  model: "gpt-4o",
  apiKey: "sk-test",
  ...over,
});

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
});
afterEach(() => vi.useRealTimers());

describe("streamChat RPM gate", () => {
  it("无 rpmLimit → 直通，不产 ratelimit-wait", async () => {
    const events = await collect(streamChat(config(), [{ role: "user", content: "hi" }]));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
  });

  it("rpmLimit=1 连发两条 → 第二条先产 ratelimit-wait 再流式", async () => {
    const cfg = config({ rpmLimit: 1, rateKey: "inst-1" });
    await collect(streamChat(cfg, [{ role: "user", content: "a" }]));
    const events: StreamEvent[] = [];
    const gen = streamChat(cfg, [{ role: "user", content: "b" }]);
    const done = (async () => { for await (const e of gen) events.push(e); })();
    await vi.advanceTimersByTimeAsync(0);
    expect(events[0]).toMatchObject({ type: "ratelimit-wait" });
    expect((events[0] as { resumeAt: number }).resumeAt).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(60_100);
    await done;
    expect(events.map((e) => e.type)).toEqual(["ratelimit-wait", "text-delta", "done"]);
  });

  it("等待中 abort → generator 静默终止（不 throw、不发请求）", async () => {
    const cfg = config({ rpmLimit: 1, rateKey: "inst-2" });
    await collect(streamChat(cfg, [{ role: "user", content: "a" }]));
    const ac = new AbortController();
    const events: StreamEvent[] = [];
    const done = (async () => {
      for await (const e of streamChat(cfg, [{ role: "user", content: "b" }], ac.signal)) events.push(e);
    })();
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await done; // 不应 reject
    expect(events.map((e) => e.type)).toEqual(["ratelimit-wait"]);
  });
});
