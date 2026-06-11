import { useEffect, useState } from "react";
import type { ErrorKind } from "@/lib/model-router/types";
import { listInstances } from "@/lib/instances";
import { openPortal } from "@/lib/managed-account";

export interface ManagedErrorCtaDeps {
  getManagedKey?: () => Promise<string | null>;
  portal?: (apiKey: string) => Promise<void>;
}

async function defaultGetManagedKey(): Promise<string | null> {
  const insts = await listInstances();
  return insts.find((i) => i.provider === "managed")?.apiKey ?? null;
}

export default function ManagedErrorCta({ kind, deps }: { kind: ErrorKind | null; deps?: ManagedErrorCtaDeps }) {
  const getManagedKey = deps?.getManagedKey ?? defaultGetManagedKey;
  const portal = deps?.portal ?? ((k: string) => openPortal(k));
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (kind === "budget" || kind === "auth") {
      void getManagedKey().then((k) => {
        if (live) setKey(k);
      });
    } else {
      setKey(null);
    }
    return () => {
      live = false;
    };
  }, [kind, getManagedKey]);

  if (!key || (kind !== "budget" && kind !== "auth")) return null;
  if (kind === "auth") {
    return <div className="mt-1.5 text-[12px] text-fg-3">Your session expired — sign in again from Settings → Configs.</div>;
  }
  return (
    <button
      type="button"
      onClick={() => portal(key)}
      className="mt-1.5 h-8 rounded-[10px] bg-accent px-3 text-[12px] font-medium text-canvas"
    >
      Manage subscription
    </button>
  );
}
