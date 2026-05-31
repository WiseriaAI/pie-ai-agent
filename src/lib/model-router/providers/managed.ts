import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";
import { refreshJwt } from "@/lib/managed-auth";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  // Supabase Edge Functions 按函数名路由：聊天函数是 `v1-chat`，所以把 baseUrl 指到该函数
  // （registry 的 defaultBaseUrl 是 .../functions/v1）。openai-compat-core 再在其后拼 chat/completions，
  // 整条 .../functions/v1/v1-chat/** 都由网关路由到 v1-chat 函数。
  let active: ModelConfig = {
    ...config,
    baseUrl: `${(config.baseUrl ?? "").replace(/\/$/, "")}/v1-chat`,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let auth401 = false;
    for await (const ev of streamChatOpenAICompat(active, messages, signal, tools, {
      authHeaders: (c) => ({ authorization: `Bearer ${c.apiKey}` }),
    })) {
      if (ev.type === "error" && ev.status === 401 && attempt === 0) {
        auth401 = true;
        break; // don't surface; go refresh
      }
      yield ev;
    }
    if (!auth401) return;
    try {
      const fresh = await refreshJwt();
      active = { ...active, apiKey: fresh };
    } catch {
      yield { type: "error", error: "登录已失效，请重新登录官方服务", status: 401 };
      return;
    }
  }
}
