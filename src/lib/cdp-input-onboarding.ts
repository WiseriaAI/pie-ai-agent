import {
  setCdpInputEnabled,
  type CdpInputState,
} from "./cdp-input-enabled";

interface PendingRequest {
  resolve: (granted: boolean) => void;
  reject: (err: Error) => void;
}

const portsBySession = new Map<string, chrome.runtime.Port>();
const pendingBySession = new Map<string, PendingRequest>();

export function registerOnboardingPort(
  sessionId: string,
  port: chrome.runtime.Port,
): void {
  portsBySession.set(sessionId, port);
}

export function unregisterOnboardingPort(sessionId: string): void {
  portsBySession.delete(sessionId);
  const pending = pendingBySession.get(sessionId);
  if (pending) {
    pending.reject(new Error("Onboarding cancelled (panel closed)"));
    pendingBySession.delete(sessionId);
  }
}

/**
 * Send a consent request to the sidepanel and resolve when user answers.
 * Also resolves true if another session flips the storage flag to true.
 * Rejects if the port unregisters (panel close) before response.
 */
export async function requestCdpInputConsent(
  sessionId: string,
): Promise<boolean> {
  const port = portsBySession.get(sessionId);
  if (!port) {
    throw new Error(
      `Cannot request CDP input consent: no sidepanel port for session ${sessionId}`,
    );
  }
  return new Promise<boolean>((resolve, reject) => {
    pendingBySession.set(sessionId, { resolve, reject });
    port.postMessage({
      type: "cdp-onboarding-request",
      sessionId,
    });
  });
}

export async function handleOnboardingResponse(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  await setCdpInputEnabled(enabled);
  const pending = pendingBySession.get(sessionId);
  if (pending) {
    pending.resolve(enabled);
    pendingBySession.delete(sessionId);
  }
}

/**
 * Called by background/index.ts when the cdp-input-enabled config flag
 * changes (via the store-bus). If the flag is now true while any session
 * is awaiting consent, auto-resolve those pending requests as accepted.
 */
export function onCdpInputEnabledChanged(enabled: CdpInputState): void {
  if (enabled !== true) return;
  for (const [sessionId, pending] of pendingBySession.entries()) {
    pending.resolve(true);
    pendingBySession.delete(sessionId);
    const port = portsBySession.get(sessionId);
    if (port) {
      port.postMessage({
        type: "cdp-onboarding-resolved",
        sessionId,
        enabled: true,
      });
    }
  }
}
