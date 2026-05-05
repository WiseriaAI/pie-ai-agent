import type { Provider } from "@/lib/model-router";

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
  id: Provider;
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
      { id: "o3", vision: false, tools: true, maxContextTokens: 200_000 },
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
      { id: "MiniMax-VL", vision: true, tools: true, maxContextTokens: 256_000 },
    ],
  },
  {
    id: "zhipu",
    name: "ZhiPu (智谱)",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    placeholder: "API key",
    models: [
      { id: "glm-4-plus", vision: false, tools: true, maxContextTokens: 128_000 },
      { id: "glm-4v-plus", vision: true, tools: true, maxContextTokens: 8_000 },
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
      { id: "gemini-2.0-pro", vision: true, tools: true, maxContextTokens: 2_000_000 },
    ],
  },
];

export function getProviderMeta(id: Provider): ProviderMeta | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}

export function getModelMeta(provider: Provider, modelId: string): ModelMeta | undefined {
  return getProviderMeta(provider)?.models.find((m) => m.id === modelId);
}
