import { useEffect, useState } from "react";
import type { ProviderRef } from "@/lib/model-router";
import type { ProviderMeta } from "@/lib/model-router/providers/registry";
import { resolveProviderMeta } from "@/lib/model-router/providers/registry";

export interface UseProviderMeta {
  meta: ProviderMeta | null;
  loading: boolean;
  error: string | null;
}

export function useProviderMeta(ref: ProviderRef | null): UseProviderMeta {
  const [meta, setMeta] = useState<ProviderMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref) {
      setMeta(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    resolveProviderMeta(ref)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setMeta(result);
        } else {
          setMeta(null);
          setError(`Unknown provider: ${ref}`);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : `Failed to resolve provider: ${ref}`);
        setMeta(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ref]);

  return { meta, loading, error };
}
