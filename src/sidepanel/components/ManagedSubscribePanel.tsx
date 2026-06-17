import { useState, useRef, useEffect, useCallback } from "react";
import { startManagedLogin, type LoginResult } from "@/lib/managed-auth";
import { getEntitlement, openCheckout } from "@/lib/managed-account";
import { useI18n } from "@/lib/i18n";
import { formatMoney } from "@/lib/managed-format";
import RedeemCodeForm from "./RedeemCodeForm";
import { Button } from "./ui/Button";
import { ManagedStatusPill } from "./ManagedStatusPill";
import { ManagedPlanIcon } from "./ManagedPlanIcon";
import { GoogleGlyph, SparkGlyph } from "./icons";
import type { Entitlement } from "@/lib/managed-auth";

function SelectRing({ checked }: { checked: boolean }) {
  if (!checked) return <span className="h-4 w-4 shrink-0 rounded-full border border-line" aria-hidden />;
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-fg-1" aria-hidden>
      <svg className="h-2.5 w-2.5 text-white" viewBox="0 0 10 10" fill="none">
        <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export interface ManagedSubscribeDeps {
  login?: () => Promise<LoginResult>;
  refresh?: (apiKey: string) => Promise<LoginResult["entitlement"]>;
  checkout?: (apiKey: string, interval?: "month" | "year") => Promise<void>;
  redeem?: (apiKey: string, code: string) => Promise<Entitlement>;
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
  const { t, locale } = useI18n();
  const login = deps?.login ?? (() => startManagedLogin());
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string, interval?: "month" | "year") => openCheckout(k, {}, interval));

  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<"month" | "year">("year");
  const [err, setErr] = useState<string | null>(null);
  const [session, setSession] = useState<LoginResult | null>(null);
  const [polling, setPolling] = useState(false);

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
      }
    } catch {
      // Silently swallow poll errors; don't surface noise to user during background polling
    }
  }, [refresh, stopPolling]);

  const startPolling = useCallback(() => {
    if (intervalRef.current !== null) return; // already polling
    pollCountRef.current = 0;
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
      setErr(e instanceof Error ? e.message : t("managed.subscribe.loginFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckout(interval: "month" | "year") {
    if (!session) return;
    setErr(null);
    try {
      await checkout(session.apiKey, interval);
      // Start auto-polling after checkout opens the Stripe tab
      startPolling();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("managed.account.checkoutFailed"));
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
      setErr(t("managed.subscribe.notActiveYet"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("managed.subscribe.refreshFailed"));
    } finally {
      setBusy(false);
    }
  }

  // No card chrome: this panel renders inside NewConfigWizard's body, which
  // already provides the bordered bg-surface container + padding (mirrors the
  // BYOK form and ManagedAccountPanel). A self-border here would double up.
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      {!session ? (
        <>
          <div className="flex items-center gap-3">
            <ManagedPlanIcon size={36} className="shrink-0" />
            <div className="flex flex-col gap-0.5">
              <div className="text-[14px] font-medium text-fg-1">{t("managed.subscribe.signInTitle")}</div>
              <div className="font-mono text-[11px] text-fg-3">{t("managed.subscribe.signInCaption")}</div>
            </div>
          </div>
          <p className="leading-[19px] text-fg-2">{t("managed.subscribe.signInBody")}</p>
          <div className="flex items-center gap-2 text-[11px] font-medium text-fg-2">
            <span>{t("managed.subscribe.benefitModels")}</span>
            <span className="h-[3px] w-[3px] rounded-full bg-line" />
            <span>{t("managed.subscribe.benefitQuota")}</span>
            <span className="h-[3px] w-[3px] rounded-full bg-line" />
            <span>{t("managed.subscribe.benefitNoSetup")}</span>
          </div>
          <Button
            variant="primary"
            size="md"
            fullWidth
            loading={busy}
            onClick={handleLogin}
            iconLeft={<GoogleGlyph />}
          >
            {t("managed.subscribe.signInButton")}
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="caps text-fg-3">{t("managed.account.section")}</div>
            <ManagedStatusPill tone="neutral" label={t("managed.account.inactive")} />
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">
              {t("managed.account.noSubscription")}
            </div>
            <div className="font-mono text-[12px] text-fg-2">{session.entitlement.email}</div>
          </div>
          <p className="text-[12px] leading-[17px] text-fg-2">{t("managed.account.noneBody")}</p>
          {session.entitlement.plan === "none" && session.entitlement.introOffer && !session.entitlement.pricing && (
            <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-accent/15 px-2.5 py-1 text-[12px] font-medium text-accent">
              <SparkGlyph />
              {t("managed.subscribe.introBadge", { percentOff: session.entitlement.introOffer.percentOff })}
            </span>
          )}
          <div className="flex flex-col gap-1">
            {polling ? (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center justify-center gap-2 rounded-control bg-field py-2.5 text-[12px] text-fg-2"
              >
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8A6 6 0 1 1 2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                {t("managed.subscribe.waiting")}
              </div>
            ) : session.entitlement.plan === "none" && session.entitlement.pricing ? (
              (() => {
                const pricing = session.entitlement.pricing;
                const fmt = (a: number) => formatMoney(a, pricing.currency, locale);
                return (
                  <div className="flex flex-col gap-3">
                    <div role="radiogroup" aria-label={t("managed.account.subscribe")} className="flex gap-2">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected === "month"}
                        disabled={busy}
                        onClick={() => setSelected("month")}
                        className={`flex flex-1 basis-0 flex-col gap-1 rounded-control border p-3 text-left transition-colors ${selected === "month" ? "border-fg-1" : "border-line"}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[12px] font-medium text-fg-2">{t("managed.subscribe.monthly")}</span>
                          <SelectRing checked={selected === "month"} />
                        </div>
                        <div className="text-[16px] font-semibold text-fg-1">
                          {fmt(pricing.monthly.amount)}
                          <span className="text-[12px] font-normal text-fg-3">{t("managed.subscribe.pricePerMonthSuffix")}</span>
                        </div>
                        {pricing.monthly.introAmount != null ? (
                          <>
                            <span className="self-start rounded-full bg-fg-1 px-2 py-0.5 text-[11px] font-medium text-white">
                              {t("managed.subscribe.introFirstMonth", { price: fmt(pricing.monthly.introAmount) })}
                            </span>
                            <span className="text-[11px] text-fg-3">
                              {t("managed.subscribe.introNote", { percentOff: pricing.monthly.introPercentOff! })}
                            </span>
                          </>
                        ) : (
                          <span className="text-[11px] text-fg-3">{t("managed.subscribe.billedMonthlyNote")}</span>
                        )}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected === "year"}
                        disabled={busy}
                        onClick={() => setSelected("year")}
                        className={`flex flex-1 basis-0 flex-col gap-1 rounded-control border p-3 text-left transition-colors ${selected === "year" ? "border-fg-1" : "border-line"}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[12px] font-medium text-fg-2">{t("managed.subscribe.annual")}</span>
                          <SelectRing checked={selected === "year"} />
                        </div>
                        <div className="text-[16px] font-semibold text-fg-1">
                          {fmt(pricing.annual.amount)}
                          <span className="text-[12px] font-normal text-fg-3">{t("managed.subscribe.pricePerYearSuffix")}</span>
                        </div>
                        {pricing.annual.savePercent > 0 && (
                          <span className="self-start rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                            {t("managed.subscribe.annualSaveBadge", { percent: pricing.annual.savePercent })}
                          </span>
                        )}
                        <span className="text-[11px] text-fg-3">
                          {t("managed.subscribe.annualPerMonthNote", { price: fmt(pricing.annual.perMonthAmount) })}
                        </span>
                      </button>
                    </div>
                    <Button variant="primary" size="md" fullWidth disabled={busy} onClick={() => handleCheckout(selected)}>
                      {selected === "year" ? t("managed.subscribe.subscribeAnnual") : t("managed.subscribe.subscribeMonthly")}
                    </Button>
                  </div>
                );
              })()
            ) : (
              <Button variant="primary" size="md" fullWidth disabled={busy} onClick={() => handleCheckout("month")}>
                {t("managed.account.subscribe")}
              </Button>
            )}
            <Button variant="ghost" size="sm" fullWidth disabled={busy} onClick={handleRefresh}>
              {t("managed.subscribe.refreshStatus")}
            </Button>
          </div>
          {session.entitlement.plan === "none" && (
            <div className="border-t border-line pt-3.5">
              <RedeemCodeForm
                apiKey={session.apiKey}
                collapsible
                onRedeemed={(ent) => {
                  if (ent.plan === "active") {
                    stopPolling();
                    onCreated(session.apiKey, ent.email);
                  } else {
                    setSession({ ...session, entitlement: ent });
                  }
                }}
                deps={deps?.redeem ? { redeem: deps.redeem } : undefined}
              />
            </div>
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
