import type { BuiltinProvider, ProviderRef } from "@/lib/model-router";
import { getCustomProvider } from "@/lib/custom-providers";
import { getProviderCustomModelMeta } from "@/lib/provider-custom-model-meta";

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

// Kimi (Moonshot) curated models — shared by both the international
// (api.moonshot.ai) and China (api.moonshot.cn) registry entries so the two
// stay in lockstep. kimi-k2.x are multimodal; moonshot-v1-* are text fallbacks.
const MOONSHOT_MODELS: ModelMeta[] = [
  { id: "kimi-k2.6", vision: true, tools: true, maxContextTokens: 256_000 },
  { id: "kimi-k2.5", vision: true, tools: true, maxContextTokens: 256_000 },
  { id: "moonshot-v1-128k", vision: false, tools: true, maxContextTokens: 128_000 },
  { id: "moonshot-v1-32k", vision: false, tools: true, maxContextTokens: 32_000 },
];

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
    defaultBaseUrl: "https://api.minimaxi.com",
    placeholder: "eyJ...",
    models: [
      { id: "MiniMax-M3", vision: true, tools: true, maxContextTokens: 1_000_000 },
      { id: "MiniMax-M2.7", vision: false, tools: true, maxContextTokens: 204_800 },
      { id: "MiniMax-M2.7-highspeed", vision: false, tools: true, maxContextTokens: 204_800 },
      { id: "MiniMax-M2.5", vision: false, tools: true, maxContextTokens: 204_800 },
      { id: "MiniMax-M2.5-highspeed", vision: false, tools: true, maxContextTokens: 204_800 },
      { id: "MiniMax-M2.1", vision: false, tools: true, maxContextTokens: 204_800 },
      { id: "MiniMax-M2.1-highspeed", vision: false, tools: true, maxContextTokens: 204_800 },
      { id: "MiniMax-M2", vision: false, tools: true, maxContextTokens: 204_800 },
    ],
  },
  {
    id: "zhipu",
    name: "GLM(Zhipu)",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    placeholder: "API key",
    // Curated from the BigModel model-overview (issue #106). Only chat /
    // vision models are listed — the agent loop requires tool calling, so
    // image-gen / video / TTS-ASR / embedding / rerank models are out of
    // scope. Deprecated lines (GLM-Z1, GLM-4-0520) and the soon-to-retire
    // GLM-4.5-Flash are intentionally omitted. maxContextTokens = input window.
    models: [
      // Text
      { id: "glm-5.1", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "glm-5", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "glm-5-turbo", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "glm-4.7", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "glm-4.7-flashx", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "glm-4.7-flash", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "glm-4.6", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "glm-4.5-air", vision: false, tools: true, maxContextTokens: 128_000 },
      { id: "glm-4.5-airx", vision: false, tools: true, maxContextTokens: 128_000 },
      { id: "glm-4-long", vision: false, tools: true, maxContextTokens: 1_000_000 },
      { id: "glm-4-flashx-250414", vision: false, tools: true, maxContextTokens: 128_000 },
      { id: "glm-4-flash-250414", vision: false, tools: true, maxContextTokens: 128_000 },
      // Vision
      { id: "glm-5v-turbo", vision: true, tools: true, maxContextTokens: 200_000 },
      { id: "glm-4.6v", vision: true, tools: true, maxContextTokens: 128_000 },
      { id: "glm-4.6v-flash", vision: true, tools: true, maxContextTokens: 128_000 },
      { id: "glm-4.1v-thinking-flashx", vision: true, tools: true, maxContextTokens: 64_000 },
      { id: "glm-4.1v-thinking-flash", vision: true, tools: true, maxContextTokens: 64_000 },
      { id: "glm-4v-flash", vision: true, tools: true, maxContextTokens: 16_000 },
    ],
  },
  {
    id: "bailian",
    name: "Bailian",
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
    name: "Mimo(Xiaomi)",
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
    id: "moonshot",
    name: "Moonshot(Kimi)",
    defaultBaseUrl: "https://api.moonshot.ai",
    placeholder: "sk-...",
    models: MOONSHOT_MODELS,
  },
  {
    id: "moonshot-cn",
    name: "Moonshot(Kimi) China",
    defaultBaseUrl: "https://api.moonshot.cn",
    placeholder: "sk-...",
    models: MOONSHOT_MODELS,
  },
  {
    id: "stepfun",
    name: "StepFun(阶跃星辰)",
    defaultBaseUrl: "https://api.stepfun.com",
    placeholder: "API key",
    // Anthropic-wire (`/v1/messages`, Bearer). step-3.7-flash is the native
    // multimodal flagship (image/video in); step-3.5-flash is the reasoning /
    // tool-calling flagship, text-only here (vision guard is fail-closed). Both
    // 256K. step-router-v1 lives on the separate `/step_plan/v1/messages`
    // channel and has no image support — intentionally omitted.
    models: [
      { id: "step-3.7-flash", vision: true, tools: true, maxContextTokens: 256_000 },
      { id: "step-3.5-flash", vision: false, tools: true, maxContextTokens: 256_000 },
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
  // Builtin: registry preset first (preset wins, not overridable)
  if (!ref.startsWith("custom:")) {
    const builtinRef = ref as BuiltinProvider; // guard above guarantees this
    const hit = getModelMeta(builtinRef, modelId);
    if (hit) return hit;
    // Then user-set sidecar meta (pcmm). tools is not user-configurable for
    // builtin custom models — forced true (loop always sends tools anyway).
    const stored = await getProviderCustomModelMeta(builtinRef, modelId);
    if (stored) {
      return {
        id: modelId,
        ...(stored.displayName ? { displayName: stored.displayName } : {}),
        vision: stored.vision,
        tools: true,
        maxContextTokens: stored.maxContextTokens,
      };
    }
    return null;
  }

  // Custom provider models (unchanged)
  const id = ref.slice("custom:".length);
  const cp = await getCustomProvider(id);
  if (!cp) return null;
  return cp.models.find((m) => m.id === modelId) ?? null;
}

/**
 * Resolve vision capability for a (provider, model) pair, with optional
 * fallback to per-instance fetched catalogs.
 *
 * Lookup order:
 *   1. Hardcoded registry (covers all non-OpenRouter providers — `models[]` is
 *      non-empty for these; see PROVIDER_REGISTRY).
 *   2. Caller-supplied `fetchedModels` (covers OpenRouter, whose registry
 *      `models: []` is intentionally empty and populated lazily per-instance
 *      via `/v1/models`).
 *
 * Returns `undefined` when the model is unknown to both. The agent loop's
 * `filterToolsByVision` is fail-CLOSED: only `vision === true` is offered
 * screenshot tools; `undefined` (and `false`) are excluded. Builtin custom
 * models carry vision in the pcmm sidecar, so `resolveInstanceToModelConfig`
 * (and the Chat attach-button via `resolveSupportsVision`) fall back to
 * `resolveModelMeta` on a miss here before anything sees a bare `undefined`.
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
