import { useState } from "react";
import { loginWithOAuth, getStoredAuth } from "@/lib/managed-auth";
import { createManagedInstance, setActiveInstance } from "@/lib/instances";

interface Props {
  onDone: (instanceId: string) => void;
}

export function ManagedLoginCard({ onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleLogin() {
    setBusy(true);
    setErr(null);
    try {
      const ent = await loginWithOAuth();
      const stored = await getStoredAuth();
      const tier = ent.tiers[0]?.tierId ?? "default";
      const id = await createManagedInstance(stored!.jwt, tier);
      await setActiveInstance(id);
      onDone(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-field px-4 py-3.5 flex flex-col gap-3">
      <div className="text-[13px] text-fg-1 font-medium">用官方服务（免 API key）</div>
      <div className="text-[12px] text-fg-2">
        登录即送免费额度，无需自带 key。流量会经过 Pie 服务器；BYOK 仍是端到端直连。
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={handleLogin}
        className="rounded-lg bg-accent px-3 py-2 text-[12px] text-white disabled:opacity-50"
      >
        {busy ? "登录中…" : "用 Google 登录"}
      </button>
      {err && <div className="text-[12px] text-warning">{err}</div>}
    </div>
  );
}
