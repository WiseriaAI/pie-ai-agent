import { useState } from "react";
import { redeem as redeemApi, RedeemError } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";
import { useI18n, type DictKey } from "@/lib/i18n";
import { Collapse } from "./ui/Collapse";
import { ChevronGlyph } from "./icons";

export interface RedeemCodeFormDeps {
  redeem?: (apiKey: string, code: string) => Promise<Entitlement>;
}
interface Props {
  apiKey: string;
  /** 兑换成功后回调（已是新鲜 entitlement）。 */
  onRedeemed: (ent: Entitlement) => void;
  deps?: RedeemCodeFormDeps;
  /** When true, render the label as a toggle that reveals the input via Collapse. */
  collapsible?: boolean;
}

/** RedeemError code → i18n key。 */
function errKey(e: unknown): DictKey {
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

export default function RedeemCodeForm({ apiKey, onRedeemed, deps, collapsible = false }: Props) {
  const { t } = useI18n();
  const doRedeem = deps?.redeem ?? ((k: string, c: string) => redeemApi(k, c));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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

  const inputRow = (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("managed.redeem.placeholder")}
          className="h-9 flex-1 rounded-control border border-line bg-field px-3 font-mono text-[12px] uppercase placeholder:normal-case placeholder:text-fg-3"
        />
        <button
          type="button"
          disabled={busy || !code.trim()}
          onClick={submit}
          className="h-9 shrink-0 rounded-control border border-line px-3 text-[12px] text-fg-2 transition-colors hover:border-fg-3 hover:text-fg-1 disabled:opacity-40"
        >
          {busy ? t("managed.redeem.redeeming") : t("managed.redeem.button")}
        </button>
      </div>
      {err && <div className="text-[12px] text-warning">{err}</div>}
    </div>
  );

  if (collapsible) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between"
        >
          <span className="text-[12px] text-fg-2">{t("managed.redeem.label")}</span>
          <span className="flex items-center gap-1 text-[12px] font-medium text-accent">
            {!open && t("managed.redeem.button")}
            <span className={`transition-transform ${open ? "rotate-90" : ""}`}>
              <ChevronGlyph />
            </span>
          </span>
        </button>
        <Collapse open={open}>
          <div className="pt-1">{inputRow}</div>
        </Collapse>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] text-fg-3">{t("managed.redeem.label")}</label>
      {inputRow}
    </div>
  );
}
