import type { BuiltinProvider, ProviderRef } from "@/lib/model-router";
import { getCustomProvider } from "@/lib/custom-providers";

export interface ModelMeta {
  /** Provider-native model id (sent to API as-is). */
  id: string;
  /** Optional friendly name for dropdown display. Falls back to id. */
  displayName?: string;
  /** Image input supported by this specific model. */
  vision: boolean;
  /** Tool / function calling supported. */
  tools: boolean;
  /** Approximate context window for the token-budget guard. */
  maxContextTokens: number;
}

export interface ProviderMeta {
  id: ProviderRef;
  name: string;
  /** Hardcoded official endpoint. Single source of truth — UI never edits. */
  defaultBaseUrl: string;
  placeholder: string;
  /**
   * Hardcoded curated model list, synced with each release. Empty array
   * means the provider's models are fetched lazily from `modelsEndpoint`
   * (currently only OpenRouter).
   */
  models: ModelMeta[];
  /**
   * Relative endpoint for lazy GET of available models. When set + models[]
   * is empty, the Settings UI fetches on first instance dropdown open and
   * caches per instance.
   */
  modelsEndpoint?: string;
}

export const PROVIDER_REGISTRY: ProviderMeta[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    placeholder: "sk-ant-...",
    models: [
      { id: "claude-opus-4-7", vision: true, tools: true, maxContextTokens: 200_000 },
      { id: "claude-sonnet-4-6", vision: true, tools: true, maxContextTokens: 200_000 },
      { id: "claude-haiku-4-5-20251001", displayName: "claude-haiku-4-5", vision: true, tools: true, maxContextTokens: 200_000 },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com",
    placeholder: "sk-...",
    models: [
      { id: "gpt-4o", vision: true, tools: true, maxContextTokens: 128_000 },
      { id: "gpt-4o-mini", vision: true, tools: true, maxContextTokens: 128_000 },
      { id: "o3-mini", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "o3", vision: true, tools: true, maxContextTokens: 200_000 },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api",
    placeholder: "sk-or-...",
    models: [],
    modelsEndpoint: "/v1/models",
  },
  {
    id: "minimax",
    name: "MiniMax",
    defaultBaseUrl: "https://api.minimax.chat",
    placeholder: "eyJ...",
    models: [
      { id: "MiniMax-Text-01", vision: false, tools: true, maxContextTokens: 1_000_000 },
      { id: "MiniMax-VL-01", vision: true, tools: true, maxContextTokens: 256_000 },
    ],
  },
  {
    id: "zhipu",
    name: "ZhiPu (智谱)",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    placeholder: "API key",
    models: [
      { id: "glm-4-plus", vision: false, tools: true, maxContextTokens: 128_000 },
      { id: "glm-4v-plus", vision: true, tools: true, maxContextTokens: 16_000 },
      { id: "glm-4-air", vision: false, tools: true, maxContextTokens: 128_000 },
    ],
  },
  {
    id: "bailian",
    name: "Bailian (百炼)",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    placeholder: "sk-...",
    models: [
      { id: "qwen-max", vision: false, tools: true, maxContextTokens: 32_000 },
      { id: "qwen-vl-max", vision: true, tools: true, maxContextTokens: 32_000 },
      { id: "qwen-plus", vision: false, tools: true, maxContextTokens: 128_000 },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    placeholder: "AIza...",
    models: [
      { id: "gemini-2.0-flash", vision: true, tools: true, maxContextTokens: 1_000_000 },
      { id: "gemini-2.5-pro", vision: true, tools: true, maxContextTokens: 1_000_000 },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    placeholder: "sk-...",
    models: [
      { id: "deepseek-v4-flash", vision: false, tools: true, maxContextTokens: 1_000_000 },
      { id: "deepseek-v4-pro", vision: false, tools: true, maxContextTokens: 1_000_000 },
    ],
  },
  {
    id: "mimo",
    name: "MiMo (小米)",
    defaultBaseUrl: "https://api.xiaomimimo.com",
    placeholder: "API key",
    models: [
      { id: "mimo-v2.5-pro", vision: false, tools: true, maxContextTokens: 1_000_000 },
      { id: "mimo-v2.5",     vision: true,  tools: true, maxContextTokens: 1_000_000 },
      { id: "mimo-v2-pro",   vision: false, tools: true, maxContextTokens: 1_000_000 },
      { id: "mimo-v2-omni",  vision: true,  tools: true, maxContextTokens: 256_000   },
      { id: "mimo-v2-flash", vision: false, tools: true, maxContextTokens: 256_000   },
    ],
  },
  {
    id: "managed",
    name: "Pie 官方服务",
    // ⚠️ replace with real Supabase project ref before launch
    defaultBaseUrl: "https://YOUR_PROJECT_REF.supabase.co/functions/v1",
    placeholder: "（登录后自动填充）",
    models: [
      { id: "default",  displayName: "标准", vision: true, tools: true, maxContextTokens: 1_000_000 },
      { id: "advanced", displayName: "深度", vision: true, tools: true, maxContextTokens: 1_000_000 },
    ],
  },
];

export function getProviderMeta(id: BuiltinProvider): ProviderMeta | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}

export function getModelMeta(provider: BuiltinProvider, modelId: string): ModelMeta | undefined {
  return getProviderMeta(provider)?.models.find((m) => m.id === modelId);
}

/**
 * Async version of getProviderMeta that works for both builtin and custom
 * providers. Custom providers are loaded from storage and a dynamic
 * ProviderMeta is constructed on the fly.
 */
export async function resolveProviderMeta(ref: ProviderRef): Promise<ProviderMeta | null> {
  // Try builtin first
  const builtin = getProviderMeta(ref as BuiltinProvider);
  if (builtin) return builtin;

  // Try custom provider
  if (ref.startsWith("custom:")) {
    const id = ref.slice("custom:".length);
    const cp = await getCustomProvider(id);
    if (!cp) return null;
    return {
      id: ref,
      name: cp.name,
      defaultBaseUrl: cp.baseUrl,
      placeholder: "Custom",
      models: cp.models,
      modelsEndpoint: undefined,
    };
  }

  return null;
}

/**
 * Async version of getModelMeta that works for both builtin and custom providers.
 */
export async function resolveModelMeta(ref: ProviderRef, modelId: string): Promise<ModelMeta | null> {
  // Try builtin first
  if (!ref.startsWith("custom:")) {
    const hit = getModelMeta(ref as BuiltinProvider, modelId);
    if (hit) return hit;
  }

  // Try custom provider models
  if (ref.startsWith("custom:")) {
    const id = ref.slice("custom:".length);
    const cp = await getCustomProvider(id);
    if (!cp) return null;
    const model = cp.models.find((m) => m.id === modelId);
    return model ?? null;
  }

  return null;
}

/**
 * Resolve vision capability for a (provider, model) pair, with optional
 * fallback to per-instance fetched catalogs.
 *
 * Lookup order:
 *   1. Hardcoded registry (covers anthropic, openai, minimax, zhipu, bailian,
 *      gemini, deepseek — `models[]` is non-empty for these).
 *   2. Caller-supplied `fetchedModels` (covers OpenRouter, whose registry
 *      `models: []` is intentionally empty and populated lazily per-instance
 *      via `/v1/models`).
 *
 * Returns `undefined` when the model is unknown to both — callers decide
 * fail-open vs fail-closed for that case. The screenshot vision guard in
 * `runAgentLoop` treats `undefined` as fail-open (let the LLM be the second
 * line of defense) so user-typed custom OpenRouter ids aren't silently locked
 * out of screenshot tools.
 */
export function resolveModelVision(
  provider: BuiltinProvider,
  modelId: string,
  fetchedModels?: Pick<ModelMeta, "id" | "vision">[],
): boolean | undefined {
  const registryHit = getModelMeta(provider, modelId);
  if (registryHit) return registryHit.vision;
  const fetchedHit = fetchedModels?.find((m) => m.id === modelId);
  if (fetchedHit) return fetchedHit.vision;
  return undefined;
}
