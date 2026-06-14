import { useState, useRef, useEffect, useCallback } from "react";
import { startManagedLogin, type LoginResult } from "@/lib/managed-auth";
import { getEntitlement, openCheckout } from "@/lib/managed-account";
import { useI18n } from "@/lib/i18n";

export interface ManagedSubscribeDeps {
  login?: () => Promise<LoginResult>;
  refresh?: (apiKey: string) => Promise<LoginResult["entitlement"]>;
  checkout?: (apiKey: string) => Promise<void>;
}

interface Props {
  /** Called once subscription is confirmed active. */
  onCreated: (apiKey: string, email: string) => void;
  deps?: ManagedSubscribeDeps;
  /** Poll interval in ms. Default 4000. Inject a smaller value in tests. */
  pollIntervalMs?: number;
}

/** Max number of polls before giving up (~5 min at 4s interval). */
const MAX_POLLS = 75;

export default function ManagedSubscribePanel({
  onCreated,
  deps,
  pollIntervalMs = 4000,
}: Props) {
  const { t } = useI18n();
  const login = deps?.login ?? (() => startManagedLogin());
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [session, setSession] = useState<LoginResult | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  // Refs for cleanup without stale closures
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const mountedRef = useRef(true);

  // Keep latest session in a ref for use inside callbacks without re-registering effects
  const sessionRef = useRef<LoginResult | null>(null);
  sessionRef.current = session;

  // Keep onCreated in a ref so the polling callback always uses the latest
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (mountedRef.current) {
      setPolling(false);
    }
  }, []);

  const checkEntitlement = useCallback(async () => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;

    try {
      const ent = await refresh(currentSession.apiKey);
      if (!mountedRef.current) return;

      if (ent.plan === "active") {
        stopPolling();
        onCreatedRef.current(currentSession.apiKey, ent.email);
        return;
      }

      pollCountRef.current += 1;
      if (pollCountRef.current >= MAX_POLLS) {
        stopPolling();
        setPollTimedOut(true);
      }
    } catch {
      // Silently swallow poll errors; don't surface noise to user during background polling
    }
  }, [refresh, stopPolling]);

  const startPolling = useCallback(() => {
    if (intervalRef.current !== null) return; // already polling
    pollCountRef.current = 0;
    setPollTimedOut(false);
    setPolling(true);
    intervalRef.current = setInterval(() => {
      void checkEntitlement();
    }, pollIntervalMs);
  }, [checkEntitlement, pollIntervalMs]);

  // Focus listener: immediate check when user switches back to the extension
  useEffect(() => {
    if (!polling) return;

    function handleFocus() {
      void checkEntitlement();
    }

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [polling, checkEntitlement]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  async function handleLogin() {
    setBusy(true);
    setErr(null);
    try {
      const res = await login();
      if (res.entitlement.plan === "active") {
        onCreated(res.apiKey, res.entitlement.email);
        return;
      }
      setSession(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckout() {
    if (!session) return;
    setErr(null);
    try {
      await checkout(session.apiKey);
      // Start auto-polling after checkout opens the Stripe tab
      startPolling();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to open checkout");
    }
  }

  async function handleRefresh() {
    if (!session) return;
    setBusy(true);
    setErr(null);
    try {
      const ent = await refresh(session.apiKey);
      if (ent.plan === "active") {
        stopPolling();
        onCreated(session.apiKey, ent.email);
        return;
      }
      setSession({ ...session, entitlement: ent });
      setErr("Subscription not active yet — finish payment, then refresh.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-3.5 text-[13px]">
      {!session ? (
        <>
          <p className="text-fg-2">Use the official Pie service — no API key needed.</p>
          <button
            type="button"
            disabled={busy}
            onClick={handleLogin}
            className="h-9 rounded-[10px] bg-fg-1 px-4 text-[12px] font-medium text-canvas disabled:opacity-40"
          >
            {busy ? "…" : "Sign in with Google"}
          </button>
        </>
      ) : (
        <>
          <div className="text-fg-1">
            Signed in as <span className="font-mono">{session.entitlement.email}</span>
          </div>
          <div className="text-fg-3">Plan: {session.entitlement.plan}</div>
          {session.entitlement.plan === "none" && session.entitlement.introOffer && (
            <span className="self-start rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
              {t("managed.subscribe.introBadge", { percentOff: session.entitlement.introOffer.percentOff })}
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={handleCheckout}
            className="h-9 rounded-[10px] bg-accent px-4 text-[12px] font-medium text-canvas disabled:opacity-40"
          >
            Subscribe
          </button>
          {polling && (
            <p className="text-[12px] text-fg-3">
              Waiting for payment confirmation…
            </p>
          )}
          {(!polling || pollTimedOut) && (
            <button
              type="button"
              disabled={busy}
              onClick={handleRefresh}
              className="h-8 rounded-[10px] border border-line px-4 text-[12px] text-fg-2 disabled:opacity-40"
            >
              I&apos;ve paid — refresh status
            </button>
          )}
        </>
      )}
      {err && (
        <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">
          {err}
        </div>
      )}
    </div>
  );
}
