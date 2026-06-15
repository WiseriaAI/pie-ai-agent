import { useState } from "react";
import { redeem as redeemApi, RedeemError } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";
import { useI18n } from "@/lib/i18n";

export interface RedeemCodeFormDeps {
  redeem?: (apiKey: string, code: string) => Promise<Entitlement>;
}
interface Props {
  apiKey: string;
  /** 兑换成功后回调（已是新鲜 entitlement）。 */
  onRedeemed: (ent: Entitlement) => void;
  deps?: RedeemCodeFormDeps;
}

/** RedeemError code → i18n key。 */
function errKey(e: unknown): string {
  if (e instanceof RedeemError) {
    switch (e.code) {
      case "code_not_found": return "managed.redeem.errNotFound";
      case "code_already_redeemed": return "managed.redeem.errUsed";
      case "code_expired": return "managed.redeem.errExpired";
      case "too_many_attempts": return "managed.redeem.errRateLimited";
      default: return "managed.redeem.errFailed";
    }
  }
  return "managed.redeem.errFailed";
}

export default function RedeemCodeForm({ apiKey, onRedeemed, deps }: Props) {
  const { t } = useI18n();
  const doRedeem = deps?.redeem ?? ((k: string, c: string) => redeemApi(k, c));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const ent = await doRedeem(apiKey, trimmed);
      setCode("");
      onRedeemed(ent);
    } catch (e) {
      setErr(t(errKey(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] text-fg-3">{t("managed.redeem.label")}</label>
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("managed.redeem.placeholder")}
          className="h-9 flex-1 rounded-[10px] border border-line bg-field px-3 font-mono text-[12px] uppercase placeholder:normal-case placeholder:text-fg-3"
        />
        <button
          type="button"
          disabled={busy || !code.trim()}
          onClick={submit}
          className="h-9 shrink-0 rounded-[10px] border border-line px-3 text-[12px] text-fg-2 disabled:opacity-40"
        >
          {busy ? t("managed.redeem.redeeming") : t("managed.redeem.button")}
        </button>
      </div>
      {err && <div className="text-[12px] text-warning">{err}</div>}
    </div>
  );
}
