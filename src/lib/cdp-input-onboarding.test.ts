import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  requestCdpInputConsent,
  handleOnboardingResponse,
  registerOnboardingPort,
  unregisterOnboardingPort,
} from "./cdp-input-onboarding";
import { CDP_INPUT_ENABLED_STORAGE_KEY, setCdpInputEnabled } from "./cdp-input-enabled";
import { getConfig } from "./idb/config-store";
import { _resetForTests } from "./idb/db";

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

beforeEach(async () => {
  await _resetForTests();
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

  it("writes flag=true to config store when user accepts", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    handleOnboardingResponse("S1", true);
    await promise;
    expect(await getConfig<boolean>(CDP_INPUT_ENABLED_STORAGE_KEY)).toBe(true);
  });

  it("writes flag=false and resolves false when user declines", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    handleOnboardingResponse("S1", false);
    const result = await promise;
    expect(result).toBe(false);
    expect(await getConfig<boolean>(CDP_INPUT_ENABLED_STORAGE_KEY)).toBe(false);
  });

  it("rejects with onboarding-cancelled when port unregisters before response", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    unregisterOnboardingPort("S1");
    await expect(promise).rejects.toThrow("Onboarding cancelled");
  });

  it("auto-resolves true when another session flips the flag to true mid-flight", async () => {
    const port = fakePort("S1");
    registerOnboardingPort("S1", port as unknown as chrome.runtime.Port);
    const promise = requestCdpInputConsent("S1");
    // Simulate another session flipping the flag
    await setCdpInputEnabled(true);
    // The coordinator listens for store-bus changes and resolves
    // (test invokes the handler with the resolved enabled state).
    const { onCdpInputEnabledChanged } = await import("./cdp-input-onboarding");
    onCdpInputEnabledChanged(true);
    await expect(promise).resolves.toBe(true);
  });

  it("rejects with port-missing if no port registered for sessionId", async () => {
    await expect(requestCdpInputConsent("never-registered")).rejects.toThrow("no sidepanel port");
  });
});
