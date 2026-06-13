import { useEffect, useState } from "react";
import type { ErrorKind } from "@/lib/model-router/types";
import type { Entitlement } from "@/lib/managed-auth";
import { listInstances } from "@/lib/instances";
import { getEntitlement, openCheckout, openPortal } from "@/lib/managed-account";
import { formatResetDate } from "@/lib/managed-format";

export interface ManagedErrorCtaDeps {
  getManagedKey?: () => Promise<string | null>;
  getEnt?: (apiKey: string) => Promise<Entitlement>;
  portal?: (apiKey: string) => Promise<void>;
  checkout?: (apiKey: string) => Promise<void>;
}

async function defaultGetManagedKey(): Promise<string | null> {
  const insts = await listInstances();
  return insts.find((i) => i.provider === "managed")?.apiKey ?? null;
}

function CtaCard({ tone, title, body, action }: {
  tone: "warning" | "neutral";
  title: string;
  body: string;
  action?: { label: string; on: () => void };
}) {
  const box = tone === "warning" ? "border-warning-line bg-warning-tint" : "border-line bg-field";
  return (
    <div className={`mt-1.5 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 ${box}`}>
      <div className="flex flex-1 flex-col gap-0.5">
        <div className="text-[13px] font-medium text-fg-1">{title}</div>
        <div className="text-[12px] text-fg-2">{body}</div>
      </div>
      {action && (
        <button type="button" onClick={action.on}
          className="shrink-0 rounded-[9px] bg-fg-1 px-3.5 py-2 text-[12px] font-semibold text-canvas">{action.label}</button>
      )}
    </div>
  );
}

export default function ManagedErrorCta({ kind, deps }: { kind: ErrorKind | null; deps?: ManagedErrorCtaDeps }) {
  const getManagedKey = deps?.getManagedKey ?? defaultGetManagedKey;
  const getEnt = deps?.getEnt ?? ((k: string) => getEntitlement(k));
  const portal = deps?.portal ?? ((k: string) => openPortal(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));

  const [key, setKey] = useState<string | null>(null);
  const [ent, setEnt] = useState<Entitlement | null>(null);

  useEffect(() => {
    let live = true;
    if (kind === "budget" || kind === "auth") {
      void (async () => {
        const k = await getManagedKey();
        if (!live) return;
        setKey(k);
        if (!k) { setEnt(null); return; }
        try { const e = await getEnt(k); if (live) setEnt(e); }
        catch { if (live) setEnt(null); }
      })();
    } else {
      setKey(null);
      setEnt(null);
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  if (!key || (kind !== "budget" && kind !== "auth")) return null;
  if (!ent) return null; // entitlement 未就绪 → 暂不渲染，避免闪烁

  // 欠费 dunning：blocked 不论 auth/budget 都引导更新支付
  if (ent.plan === "blocked") {
    return (
      <CtaCard tone="warning" title="Payment failed" body="Update your payment method to continue."
        action={{ label: "Update payment", on: () => { void portal(key).catch(() => {}); } }} />
    );
  }

  if (kind === "auth") {
    // 非 blocked 的 401 → key 真失效/过期
    return <div className="mt-1.5 text-[12px] text-fg-3">Your session expired — sign in again from Settings → Configs.</div>;
  }

  // kind === "budget"
  if (ent.plan === "active") {
    const reset = formatResetDate(ent.quota?.weekly?.resetAt);
    return (
      <CtaCard tone="neutral" title="You've used this week's quota"
        body={reset ? `Resets ${reset}. You can keep chatting then.` : "Resets soon. You can keep chatting then."} />
    );
  }
  // plan === "none"
  return (
    <CtaCard tone="neutral" title="Subscribe to keep chatting" body="Your subscription isn't active."
      action={{ label: "Subscribe", on: () => { void checkout(key).catch(() => {}); } }} />
  );
}
