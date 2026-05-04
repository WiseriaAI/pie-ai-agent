import type { Provider } from "@/lib/model-router";

export interface ProviderMeta {
  id: Provider;
  name: string;
  defaultModel: string;
  defaultBaseUrl: string;
  placeholder: string;
  type: "anthropic" | "openai-compatible";
  supportsTools: boolean;
  /** Phase 5 multimodal — true if provider's vision wire format is wired into
   *  the corresponding shaper. v1 first wave: anthropic / openai / openrouter.
   *  Drives Chat.tsx upload affordance + risk classifier early-fail for
   *  screenshot tools (R9 mixed-vision-provider 4 sub-paths). */
  supportsVision: boolean;
  /** Approximate context window size in tokens, used by the token-budget guard (U5). */
  maxContextTokens: number;
}

export const PROVIDER_REGISTRY: ProviderMeta[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    defaultModel: "claude-sonnet-4-20250514",
    defaultBaseUrl: "https://api.anthropic.com",
    placeholder: "sk-ant-...",
    type: "anthropic",
    supportsTools: true,
    supportsVision: true,
    maxContextTokens: 200_000,
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-4o",
    defaultBaseUrl: "https://api.openai.com",
    placeholder: "sk-...",
    type: "openai-compatible",
    supportsTools: true,
    supportsVision: true,
    maxContextTokens: 128_000,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    defaultModel: "anthropic/claude-sonnet-4",
    defaultBaseUrl: "https://openrouter.ai/api",
    placeholder: "sk-or-...",
    type: "openai-compatible",
    supportsTools: true,
    supportsVision: true,
    // Conservative: OpenRouter routes to many different models; v2 can expose
    // a Settings UI to let users set the actual routed model's context window.
    maxContextTokens: 32_000,
  },
  {
    id: "minimax",
    name: "MiniMax",
    defaultModel: "MiniMax-Text-01",
    defaultBaseUrl: "https://api.minimax.chat",
    placeholder: "eyJ...",
    type: "openai-compatible",
    supportsTools: true,
    supportsVision: false,
    // Conservative default; documented context varies by model.
    maxContextTokens: 32_000,
  },
  {
    id: "zhipu",
    name: "ZhiPu (智谱)",
    defaultModel: "glm-4-plus",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    placeholder: "API key",
    type: "openai-compatible",
    supportsTools: true,
    supportsVision: false,
    // Conservative default; documented context varies by model.
    maxContextTokens: 32_000,
  },
  {
    id: "bailian",
    name: "Bailian (百炼)",
    defaultModel: "qwen-max",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    placeholder: "sk-...",
    type: "openai-compatible",
    supportsTools: true,
    supportsVision: false,
    // Conservative default; documented context varies by model.
    maxContextTokens: 32_000,
  },
];

export function getProviderMeta(id: Provider): ProviderMeta | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}
