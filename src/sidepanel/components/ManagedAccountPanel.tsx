import { useEffect, useState } from "react";
import { getEntitlement, openCheckout, openPortal } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";

export interface ManagedAccountDeps {
  refresh?: (apiKey: string) => Promise<Entitlement>;
  checkout?: (apiKey: string) => Promise<void>;
  portal?: (apiKey: string) => Promise<void>;
}

export default function ManagedAccountPanel({ apiKey, deps }: { apiKey: string; deps?: ManagedAccountDeps }) {
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));
  const portal = deps?.portal ?? ((k: string) => openPortal(k));

  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try { setEnt(await refresh(apiKey)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to load"); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [apiKey]);

  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-3.5 text-[13px]">
      {ent ? (
        <>
          <div className="text-fg-1"><span className="font-mono">{ent.email}</span></div>
          <div className="text-fg-3">Plan: <span className="text-fg-1">{ent.plan}</span> · Remaining: ${ent.budgetRemainingUsd.toFixed(2)}</div>
          {ent.plan === "active" ? (
            <button type="button" onClick={() => portal(apiKey)}
              className="h-9 rounded-[10px] border border-line px-4 text-[12px] text-fg-1 hover:border-fg-3">Manage subscription</button>
          ) : (
            <button type="button" onClick={() => checkout(apiKey)}
              className="h-9 rounded-[10px] bg-accent px-4 text-[12px] font-medium text-canvas">{ent.plan === "blocked" ? "Renew subscription" : "Subscribe"}</button>
          )}
          <button type="button" onClick={load} className="h-7 text-[11px] text-fg-3 hover:text-fg-1">Refresh</button>
        </>
      ) : (
        <div className="text-fg-3">Loading…</div>
      )}
      {err && <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">{err}</div>}
    </div>
  );
}
