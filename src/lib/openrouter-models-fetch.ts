import type { ModelMeta } from "@/lib/model-router";

/** Raw shape OpenRouter returns for each model in /v1/models. */
interface OpenRouterModelEntry {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
}

/**
 * Fetch + normalise OpenRouter's /v1/models response into our ModelMeta shape.
 *
 * Used by both Settings (existing instance refresh, uses stored apiKey) and
 * NewConfigWizard (just-typed apiKey before instance creation, no storage).
 *
 * Throws on empty key, network error, or non-2xx response — caller decides
 * whether to swallow (current v1 policy: silent retry via UI).
 */
export async function fetchOpenRouterModels(
  baseUrl: string,
  apiKey: string,
): Promise<ModelMeta[]> {
  if (!apiKey.trim()) throw new Error("API key required");
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter /v1/models returned ${res.status}`);
  const data = (await res.json()) as { data?: OpenRouterModelEntry[] };
  return (data.data ?? []).map((m) => ({
    id: m.id,
    vision: m.architecture?.input_modalities?.includes("image") ?? false,
    tools: true,
    maxContextTokens: m.context_length ?? 32_000,
  }));
}
