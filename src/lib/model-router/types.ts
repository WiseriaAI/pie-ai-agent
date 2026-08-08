// Content block types for AgentMessage IR
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    data: string;
  };
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Anthropic extended-thinking 回放签名；第三方 anthropic-compat 端点可能不带。 */
  signature?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ThinkingBlock;

// AgentMessage IR — LLM-facing message type (parallel to ChatMessage, never exposed to Panel)
// system role is constrained to string-only at type level
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user" | "assistant"; content: string | ContentBlock[] };

// Tool definition (provider-neutral)
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export type ErrorKind = "auth" | "budget" | "ratelimit" | "http" | "network";

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-start"; replay: boolean }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-end"; signature?: string }
  | { type: "tool-call-start"; id: string; index: number; name: string }
  | { type: "tool-call-delta"; index: number; argsDelta: string }
  | { type: "tool-call-end"; index: number }
  | {
      type: "done";
      stopReason?: "end" | "tool_calls" | "length";
      usage?: {
        inputTokens: number;
        outputTokens: number;
        /** Prompt tokens served from the provider's prompt/KV cache on THIS
         *  call (Anthropic cache_read_input_tokens; OpenAI-compat
         *  prompt_tokens_details.cached_tokens / prompt_cache_hit_tokens).
         *  Absent when the provider reports no cache information at all —
         *  the UI hides cache stats rather than showing a misleading 0%. */
        cachedTokens?: number;
        /** Total prompt tokens processed on this call — the denominator for
         *  the cache hit ratio. OpenAI-compat: prompt_tokens (cached included).
         *  Anthropic: input_tokens + cache_read + cache_creation (their
         *  input_tokens EXCLUDES cached portions). Present iff cachedTokens is. */
        promptTotalTokens?: number;
      };
    }
  | { type: "ratelimit-wait"; resumeAt: number }
  | { type: "error"; error: string; kind?: ErrorKind };
