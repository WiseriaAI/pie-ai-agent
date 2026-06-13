import { useEffect, useState } from "react";
import { getCachedEntitlement, getEntitlement, openCheckout, openPortal } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";
import { formatDate } from "@/lib/managed-format";
import QuotaBar from "./QuotaBar";

export interface ManagedAccountDeps {
  refresh?: (apiKey: string) => Promise<Entitlement>;
  checkout?: (apiKey: string) => Promise<void>;
  portal?: (apiKey: string) => Promise<void>;
}

function StatusPill({ tone, label }: { tone: "success" | "warning" | "neutral"; label: string }) {
  const box = {
    success: "bg-success-tint text-success",
    warning: "bg-warning-tint text-warning",
    neutral: "bg-field text-fg-2",
  }[tone];
  const dot = { success: "bg-success", warning: "bg-warning", neutral: "bg-fg-3" }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${box}`}>
      <span className={`h-[5px] w-[5px] rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export default function ManagedAccountPanel({ apiKey, deps }: { apiKey: string; deps?: ManagedAccountDeps }) {
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));
  const portal = deps?.portal ?? ((k: string) => openPortal(k));

  // 初始用进程内缓存回显（上次展开拿到的状态），避免每次展开都闪空 loading；
  // useEffect 仍会后台拉一次刷新用量等数值。
  const [ent, setEnt] = useState<Entitlement | null>(() => getCachedEntitlement(apiKey));
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try { setEnt(await refresh(apiKey)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to load"); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [apiKey]);

  async function handlePortal() {
    setErr(null);
    try { await portal(apiKey); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to open portal"); }
  }
  async function handleCheckout() {
    setErr(null);
    try { await checkout(apiKey); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to open checkout"); }
  }

  // No card chrome: this panel renders inside InstanceForm's expanded area, which
  // already provides the bordered bg-surface container + padding (see InstanceForm
  // managed branch). A self-border here would double up with the list card.
  const container = "flex flex-col gap-[18px] text-[13px]";

  if (!ent) {
    return <div className={container}><div className="text-fg-3">Loading…</div></div>;
  }

  const sub = ent.subscription;
  const isActive = ent.plan === "active";
  const isBlocked = ent.plan === "blocked";
  const periodDate = formatDate(sub?.currentPeriodEnd);

  const pill = isActive
    ? <StatusPill tone="success" label="Active" />
    : isBlocked
      ? <StatusPill tone="warning" label="Payment failed" />
      : <StatusPill tone="neutral" label="Inactive" />;

  const headline = isActive || isBlocked ? (sub?.planName ?? "Pie") : "No active subscription";

  const primary = isActive
    ? { label: "Manage subscription", on: handlePortal }
    : isBlocked
      ? { label: "Update payment method", on: handlePortal }
      : { label: "Subscribe", on: handleCheckout };

  return (
    <div className={container}>
      <div className="flex flex-col gap-[9px]">
        <div className="flex items-center justify-between">
          <div className="caps text-fg-3">SUBSCRIPTION</div>
          {pill}
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">{headline}</div>
          <div className="font-mono text-[12px] text-fg-2">{ent.email}</div>
          {isActive && periodDate && (
            sub?.cancelAtPeriodEnd ? (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[12px] text-fg-2">Cancels {periodDate}</span>
                <span className="rounded-full bg-field px-1.5 py-px font-mono text-[10px] text-fg-2">won't renew</span>
              </div>
            ) : (
              <div className="pt-0.5 text-[12px] text-fg-2">Renews {periodDate}</div>
            )
          )}
        </div>
      </div>

      {isBlocked && (
        <div className="text-[12px] leading-[17px] text-fg-2">
          Your last payment didn't go through. Update your payment method to keep using Pie.
        </div>
      )}
      {ent.plan === "none" && (
        <div className="text-[12px] leading-[17px] text-fg-2">
          Subscribe to use the official Pie service — no API key needed.
        </div>
      )}

      {isActive && ent.quota?.weekly && (
        <QuotaBar usedFraction={ent.quota.weekly.usedFraction} resetAt={ent.quota.weekly.resetAt} />
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button type="button" onClick={primary.on}
          className="h-9 rounded-[10px] bg-fg-1 px-4 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90 active:opacity-80">{primary.label}</button>
        <div className="flex-1" />
        <button type="button" onClick={load}
          className="h-9 px-2 text-[13px] text-fg-2 hover:text-fg-1">Refresh</button>
      </div>

      {err && (
        <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">{err}</div>
      )}
    </div>
  );
}
