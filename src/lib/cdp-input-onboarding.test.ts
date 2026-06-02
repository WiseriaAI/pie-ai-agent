import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  requestCdpInputConsent,
  handleOnboardingResponse,
  registerOnboardingPort,
  unregisterOnboardingPort,
} from "./cdp-input-onboarding";
import { setCdpInputEnabled, CDP_INPUT_ENABLED_STORAGE_KEY } from "./cdp-input-enabled";

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
}

function fakePort(sessionId: string): FakePort {
  return {
    name: `chat-stream-${sessionId}`,
    postMessage: vi.fn(),
  };
}

beforeEach(() => {
  const data: Record<string, unknown> = {};
  global.chrome = {
    storage: {
      local: {
        get: vi.fn((k) => {
          const want = Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const key of want) if (key in data) out[key] = data[key];
          return Promise.resolve(out);
        }),
        set: vi.fn((kv) => { Object.assign(data, kv); return Promise.resolve(); }),
        remove: vi.fn(() => Promise.resolve()),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() } as unknown as typeof chrome.storage.local.onChanged,
      },
      onChanged: { addListener: vi.fn() } as unknown as typeof chrome.storage.onChanged,
    },
  } as unknown as typeof chrome;
});

describe("requestCdpInputConsent", () => {
  it("posts onboarding-request to registered port and resolves on response=true", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "cdp-onboarding-request",
      sessionId: "S1",
    });
    handleOnboardingResponse("S1", true);
    await expect(promise).resolves.toBe(true);
  });

  it("writes flag=true to storage when user accepts", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    handleOnboardingResponse("S1", true);
    await promise;
    const r = await chrome.storage.local.get(CDP_INPUT_ENABLED_STORAGE_KEY);
    expect(r[CDP_INPUT_ENABLED_STORAGE_KEY]).toBe(true);
  });

  it("writes flag=false and resolves false when user declines", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    handleOnboardingResponse("S1", false);
    const result = await promise;
    expect(result).toBe(false);
    const r = await chrome.storage.local.get(CDP_INPUT_ENABLED_STORAGE_KEY);
    expect(r[CDP_INPUT_ENABLED_STORAGE_KEY]).toBe(false);
  });

  it("rejects with onboarding-cancelled when port unregisters before response", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    unregisterOnboardingPort("S1");
    await expect(promise).rejects.toThrow("Onboarding cancelled");
  });

  it("auto-resolves true when another session flips storage to true mid-flight", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    // Simulate another session flipping the flag
    await setCdpInputEnabled(true);
    // The coordinator listens for storage changes and resolves
    // (test invokes the registered listener manually)
    const { onStorageChanged } = await import("./cdp-input-onboarding");
    onStorageChanged({ [CDP_INPUT_ENABLED_STORAGE_KEY]: { newValue: true, oldValue: undefined } });
    await expect(promise).resolves.toBe(true);
  });

  it("rejects with port-missing if no port registered for sessionId", async () => {
    await expect(requestCdpInputConsent("never-registered")).rejects.toThrow("no sidepanel port");
  });
});
