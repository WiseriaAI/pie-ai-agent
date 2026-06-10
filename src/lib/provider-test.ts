import type { ChatMessage, ChatResponse, ModelConfig } from "@/lib/model-router";
import { chatMessagesToAgent, dispatchStreamChat } from "@/lib/model-router";

export const PROVIDER_TEST_TIMEOUT_MS = 15_000;

type ChatImpl = (
  config: ModelConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
) => Promise<ChatResponse>;

export interface ProviderConnectionTestInput {
  provider: ModelConfig["provider"];
  providerName?: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export async function testProviderConnection(
  input: ProviderConnectionTestInput,
  options: {
    timeoutMs?: number;
    chatImpl?: ChatImpl;
  } = {},
): Promise<void> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS;
  const chatImpl = options.chatImpl ?? providerProbeChat;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      chatImpl(
        {
          provider: input.provider,
          providerName: input.providerName,
          model: input.model,
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          maxTokens: 1,
        },
        [{ role: "user", content: "Hi" }],
        controller.signal,
      ),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function providerProbeChat(
  config: ModelConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<ChatResponse> {
  let content = "";
  let usage: ChatResponse["usage"];
  for await (const event of dispatchStreamChat(config)(config, chatMessagesToAgent(messages), signal)) {
    if (event.type === "text-delta") content += event.text;
    else if (event.type === "done") usage = event.usage;
    else if (event.type === "error") throw new Error(event.error);
  }
  return { content, usage };
}
