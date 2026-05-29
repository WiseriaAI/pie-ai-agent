// SW↔panel round-trip for the `request_local_file` human-in-the-loop tool.
//
// Mirrors src/lib/cdp-input-onboarding.ts: module-level Maps keyed by
// sessionId (the agent loop blocks awaiting the tool result, so there is at
// most one in-flight request per session — no requestId needed). The SW posts
// a `request-local-file` message to the panel port; the panel shows a card,
// the user picks a file, and the panel posts back `local-file-response` which
// resolves (or rejects) the pending Promise.

export interface LocalFileResult {
  name: string;
  mime: string;
  text: string;
  truncated: boolean;
}

interface PendingRequest {
  resolve: (r: LocalFileResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const portsBySession = new Map<string, chrome.runtime.Port>();
const pendingBySession = new Map<string, PendingRequest>();

const REQUEST_TIMEOUT_MS = 120_000;

export function registerLocalFilePort(
  sessionId: string,
  port: chrome.runtime.Port,
): void {
  portsBySession.set(sessionId, port);
}

export function unregisterLocalFilePort(sessionId: string): void {
  portsBySession.delete(sessionId);
  const pending = pendingBySession.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Local file request cancelled (panel closed)"));
    pendingBySession.delete(sessionId);
  }
}

/**
 * Ask the sidepanel to prompt the user for a local file. Resolves with the
 * picked file's text when the user picks one; rejects on cancel, timeout, or
 * panel close.
 */
export async function requestLocalFileFromPanel(
  sessionId: string,
): Promise<LocalFileResult> {
  const port = portsBySession.get(sessionId);
  if (!port) {
    throw new Error(
      `Cannot request local file: no sidepanel port for session ${sessionId}`,
    );
  }
  return new Promise<LocalFileResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBySession.delete(sessionId);
      reject(new Error("timed out waiting for the user to pick a file"));
      // Notify the panel so it can dismiss the lingering card. The port is
      // still registered at timeout time (unregister rejects+clears first).
      const p = portsBySession.get(sessionId);
      if (p) p.postMessage({ type: "local-file-timeout", sessionId });
    }, REQUEST_TIMEOUT_MS);
    pendingBySession.set(sessionId, { resolve, reject, timer });
    port.postMessage({ type: "request-local-file", sessionId });
  });
}

export function handleLocalFileResponse(
  sessionId: string,
  response:
    | ({ ok: true } & LocalFileResult)
    | { ok: false; reason: string },
): void {
  const pending = pendingBySession.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingBySession.delete(sessionId);
  if (response.ok) {
    pending.resolve({
      name: response.name,
      mime: response.mime,
      text: response.text,
      truncated: response.truncated,
    });
  } else {
    pending.reject(new Error(response.reason));
  }
}
