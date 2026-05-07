import type { ModelMeta } from "@/lib/model-router";
import { fetchOpenAICompatModels } from "@/lib/openai-compat-models-fetch";

/** Raw shape OpenRouter-specific fields from /v1/models. */
interface OpenRouterRawEntry {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
}

/**
 * Fetch + normalise OpenRouter's /v1/models response into our ModelMeta shape.
 *
 * Thin shell: calls the universal fetchOpenAICompatModels for common fields,
 * then supplements with OpenRouter-specific extension fields (context_length,
 * input_modalities for vision detection).
 *
 * /v1/models is a PUBLIC endpoint per OpenRouter docs — no auth required.
 * apiKey is optional; when provided it's attached as Authorization header.
 * Throws on network error or non-2xx response.
 */
export async function fetchOpenRouterModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelMeta[]> {
  const base = await fetchOpenAICompatModels(baseUrl, apiKey);

  // Re-fetch raw data to extract OpenRouter-specific fields that
  // the generic helper doesn't preserve (context_length, input_modalities).
  const trimmed = baseUrl.replace(/\/$/, "");
  const url = trimmed.match(/\/v\d+$/)
    ? `${trimmed}/models`
    : `${trimmed}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey && apiKey.trim().length > 0) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`OpenRouter /v1/models returned ${res.status}`);
  const raw = (await res.json()) as { data?: OpenRouterRawEntry[] };
  const rawMap = new Map(raw.data?.map((e) => [e.id, e]) ?? []);

  return base.map((m) => {
    const rawEntry = rawMap.get(m.id);
    return {
      id: m.id,
      vision: rawEntry?.architecture?.input_modalities?.includes("image") ?? false,
      tools: true,
      maxContextTokens: rawEntry?.context_length ?? m.maxContextTokens,
    };
  });
}
