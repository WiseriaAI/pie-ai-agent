import { useEffect, useState } from "react";
import { getCachedEntitlement, getEntitlement, openCheckout, openPortal } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";
import { formatDate } from "@/lib/managed-format";
import { useI18n } from "@/lib/i18n";
import QuotaBar from "./QuotaBar";
import RedeemCodeForm from "./RedeemCodeForm";
import { ManagedStatusPill } from "./ManagedStatusPill";

export interface ManagedAccountDeps {
  refresh?: (apiKey: string) => Promise<Entitlement>;
  checkout?: (apiKey: string) => Promise<void>;
  portal?: (apiKey: string) => Promise<void>;
  redeem?: (apiKey: string, code: string) => Promise<Entitlement>;
}

export default function ManagedAccountPanel({ apiKey, deps }: { apiKey: string; deps?: ManagedAccountDeps }) {
  const { t, locale } = useI18n();
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));
  const portal = deps?.portal ?? ((k: string) => openPortal(k));
  const redeem = deps?.redeem;

  // 初始用进程内缓存回显（上次展开拿到的状态），避免每次展开都闪空 loading；
  // useEffect 仍会后台拉一次刷新用量等数值。
  const [ent, setEnt] = useState<Entitlement | null>(() => getCachedEntitlement(apiKey));
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try { setEnt(await refresh(apiKey)); }
    catch (e) { setErr(e instanceof Error ? e.message : t("managed.account.loadFailed")); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [apiKey]);

  async function handlePortal() {
    setErr(null);
    try { await portal(apiKey); }
    catch (e) { setErr(e instanceof Error ? e.message : t("managed.account.portalFailed")); }
  }
  async function handleCheckout() {
    setErr(null);
    try { await checkout(apiKey); }
    catch (e) { setErr(e instanceof Error ? e.message : t("managed.account.checkoutFailed")); }
  }

  // No card chrome: this panel renders inside InstanceForm's expanded area, which
  // already provides the bordered bg-surface container + padding (see InstanceForm
  // managed branch). A self-border here would double up with the list card.
  const container = "flex flex-col gap-[18px] text-[13px]";

  if (!ent) {
    return <div className={container}><div className="text-fg-3">{t("managed.account.loading")}</div></div>;
  }

  const sub = ent.subscription;
  const isActive = ent.plan === "active";
  const isBlocked = ent.plan === "blocked";
  const isRedemption = isActive && sub?.source === "redemption";
  const periodDate = formatDate(sub?.currentPeriodEnd, locale);
  const intervalLabel = isActive && !isRedemption && sub?.interval
    ? sub.interval === "year" ? t("managed.account.billedYearly") : t("managed.account.billedMonthly")
    : null;

  const pill = isActive
    ? <ManagedStatusPill tone="success" label={t("managed.account.active")} />
    : isBlocked
      ? <ManagedStatusPill tone="warning" label={t("managed.account.paymentFailed")} />
      : <ManagedStatusPill tone="neutral" label={t("managed.account.inactive")} />;

  const headline = isActive || isBlocked ? (sub?.planName ?? "Pie") : t("managed.account.noSubscription");

  const primary = isActive
    ? { label: t("managed.account.manage"), on: handlePortal }
    : isBlocked
      ? { label: t("managed.account.updatePayment"), on: handlePortal }
      : { label: t("managed.account.subscribe"), on: handleCheckout };

  return (
    <div className={container}>
      <div className="flex flex-col gap-[9px]">
        <div className="flex items-center justify-between">
          <div className="caps text-fg-3">{t("managed.account.section")}</div>
          {pill}
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">{headline}</div>
          <div className="font-mono text-[12px] text-fg-2">{ent.email}</div>
          {intervalLabel && (
            <div className="pt-0.5">
              <span className="rounded-full bg-field px-1.5 py-px font-mono text-[10px] text-fg-2">{intervalLabel}</span>
            </div>
          )}
          {isActive && periodDate && (
            isRedemption ? (
              <div className="pt-0.5 text-[12px] text-fg-2">{t("managed.account.redeemedUntil", { date: periodDate })}</div>
            ) : sub?.cancelAtPeriodEnd ? (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[12px] text-fg-2">{t("managed.account.cancels", { date: periodDate })}</span>
                <span className="rounded-full bg-field px-1.5 py-px font-mono text-[10px] text-fg-2">{t("managed.account.wontRenew")}</span>
              </div>
            ) : (
              <div className="pt-0.5 text-[12px] text-fg-2">{t("managed.account.renews", { date: periodDate })}</div>
            )
          )}
        </div>
      </div>

      {isBlocked && (
        <div className="text-[12px] leading-[17px] text-fg-2">
          {t("managed.account.blockedBody")}
        </div>
      )}
      {ent.plan === "none" && (
        <div className="text-[12px] leading-[17px] text-fg-2">
          {t("managed.account.noneBody")}
        </div>
      )}

      {isActive && ent.quota?.weekly && (
        <QuotaBar usedFraction={ent.quota.weekly.usedFraction} resetAt={ent.quota.weekly.resetAt} />
      )}

      {isRedemption ? (
        <RedeemCodeForm apiKey={apiKey} onRedeemed={(e) => setEnt(e)} deps={redeem ? { redeem } : undefined} />
      ) : null}

      <div className="flex items-center gap-2 pt-0.5">
        {!isRedemption && (
          <button type="button" onClick={primary.on}
            className="h-9 rounded-[10px] bg-fg-1 px-4 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90 active:opacity-80">{primary.label}</button>
        )}
        <div className="flex-1" />
        <button type="button" onClick={load}
          className="h-9 px-2 text-[13px] text-fg-2 hover:text-fg-1">{t("managed.account.refresh")}</button>
      </div>

      {err && (
        <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">{err}</div>
      )}
    </div>
  );
}
