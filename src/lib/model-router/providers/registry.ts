import type { Provider } from "@/lib/model-router";

export interface ProviderMeta {
  id: Provider;
  name: string;
  defaultModel: string;
  defaultBaseUrl: string;
  placeholder: string;
  type: "anthropic" | "openai-compatible";
}

export const PROVIDER_REGISTRY: ProviderMeta[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    defaultModel: "claude-sonnet-4-20250514",
    defaultBaseUrl: "https://api.anthropic.com",
    placeholder: "sk-ant-...",
    type: "anthropic",
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-4o",
    defaultBaseUrl: "https://api.openai.com",
    placeholder: "sk-...",
    type: "openai-compatible",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    defaultModel: "anthropic/claude-sonnet-4",
    defaultBaseUrl: "https://openrouter.ai/api",
    placeholder: "sk-or-...",
    type: "openai-compatible",
  },
  {
    id: "minimax",
    name: "MiniMax",
    defaultModel: "MiniMax-Text-01",
    defaultBaseUrl: "https://api.minimax.chat",
    placeholder: "eyJ...",
    type: "openai-compatible",
  },
  {
    id: "zhipu",
    name: "ZhiPu (智谱)",
    defaultModel: "glm-4-plus",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    placeholder: "API key",
    type: "openai-compatible",
  },
  {
    id: "bailian",
    name: "Bailian (百炼)",
    defaultModel: "qwen-max",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    placeholder: "sk-...",
    type: "openai-compatible",
  },
];

export function getProviderMeta(id: Provider): ProviderMeta | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}
