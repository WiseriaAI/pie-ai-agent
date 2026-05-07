import type { CustomModelMeta } from "@/lib/custom-providers";

/**
 * Fetch available models from any OpenAI-compatible /v1/models endpoint.
 * Returns normalized CustomModelMeta[] with sensible defaults for missing fields.
 *
 * URL normalization: if baseUrl already ends with /v<N>, append /models directly
 * (avoiding /v1/v1/models 404). Otherwise append /v1/models.
 */
export async function fetchOpenAICompatModels(
  baseUrl: string,
  apiKey?: string,
): Promise<CustomModelMeta[]> {
  const trimmed = baseUrl.replace(/\/$/, "");
  const url = trimmed.match(/\/v\d+$/)
    ? `${trimmed}/models`
    : `${trimmed}/v1/models`;

  const headers: Record<string, string> = {};
  if (apiKey && apiKey.trim().length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Models endpoint returned ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return (data.data ?? []).map((entry) => {
    const rawId = entry.id;
    const id = typeof rawId === "string" ? rawId : String(rawId);
    return {
      id,
      displayName: undefined,
      vision: false,
      tools: true,
      maxContextTokens: 128_000,
    };
  });
}
