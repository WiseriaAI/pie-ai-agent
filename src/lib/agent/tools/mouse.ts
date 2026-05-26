import { isCdpInputEnabled } from "@/lib/cdp-input-enabled";
import type { CdpSession } from "@/background/cdp-session";

/**
 * Internal: dispatch a single CDP mouse event at the given page coords.
 */
export async function dispatchMouseAt(
  session: CdpSession,
  x: number,
  y: number,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
): Promise<void> {
  await session.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : "left",
    clickCount: type === "mouseMoved" ? 0 : 1,
    pointerType: "mouse",
  });
}

export type CdpGateResult = { ok: true } | { ok: false; error: string };

interface RequireCdpInputArgs {
  sessionId: string;
  requestConsent: (sessionId: string) => Promise<boolean>;
}

/**
 * Tri-state gate for CDP-dependent tools. Reads cdp_input_enabled:
 *   - true → ok=true
 *   - false → ok=false, error="disabled in Settings"
 *   - undefined → invoke requestConsent (inline guide); true→ok, false/throw→error
 */
export async function requireCdpInput(
  args: RequireCdpInputArgs,
): Promise<CdpGateResult> {
  const flag = await isCdpInputEnabled();
  if (flag === true) return { ok: true };
  if (flag === false) {
    return {
      ok: false,
      error: "CDP input is disabled in Settings. Cannot click/hover.",
    };
  }
  // undefined — request consent
  try {
    const granted = await args.requestConsent(args.sessionId);
    if (granted) return { ok: true };
    return {
      ok: false,
      error: "CDP input is disabled in Settings. Cannot click/hover.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Onboarding cancelled/i.test(msg)) {
      return { ok: false, error: "Onboarding cancelled (panel closed)." };
    }
    return { ok: false, error: `CDP consent error: ${msg}` };
  }
}
