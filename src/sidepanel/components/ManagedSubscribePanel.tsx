import { useState } from "react";
import { startManagedLogin, type LoginResult } from "@/lib/managed-auth";
import { getEntitlement, openCheckout } from "@/lib/managed-account";

export interface ManagedSubscribeDeps {
  login?: () => Promise<LoginResult>;
  refresh?: (apiKey: string) => Promise<LoginResult["entitlement"]>;
  checkout?: (apiKey: string) => Promise<void>;
}

interface Props {
  /** Called once subscription is confirmed active. */
  onCreated: (apiKey: string, email: string) => void;
  deps?: ManagedSubscribeDeps;
}

export default function ManagedSubscribePanel({ onCreated, deps }: Props) {
  const login = deps?.login ?? (() => startManagedLogin());
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [session, setSession] = useState<LoginResult | null>(null);

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

  async function handleRefresh() {
    if (!session) return;
    setBusy(true);
    setErr(null);
    try {
      const ent = await refresh(session.apiKey);
      if (ent.plan === "active") {
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
          <button
            type="button"
            disabled={busy}
            onClick={() => checkout(session.apiKey)}
            className="h-9 rounded-[10px] bg-accent px-4 text-[12px] font-medium text-canvas disabled:opacity-40"
          >
            Subscribe
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleRefresh}
            className="h-8 rounded-[10px] border border-line px-4 text-[12px] text-fg-2 disabled:opacity-40"
          >
            I&apos;ve paid — refresh status
          </button>
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
