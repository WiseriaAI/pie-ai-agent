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
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: "error"; error: string };
