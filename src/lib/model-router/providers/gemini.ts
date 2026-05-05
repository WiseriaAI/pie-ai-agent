import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}
interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

function toGeminiContents(messages: AgentMessage[]): GeminiContent[] {
  const result: GeminiContent[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // hoisted to systemInstruction below
    const role: GeminiContent["role"] = msg.role === "assistant" ? "model" : "user";

    if (typeof msg.content === "string") {
      result.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text") parts.push({ text: block.text });
      else if (block.type === "image") {
        parts.push({ inline_data: { mime_type: block.source.mediaType, data: block.source.data } });
      } else if (block.type === "tool_use" && msg.role === "assistant") {
        const args: Record<string, unknown> = typeof block.input === "string"
          ? (JSON.parse(block.input) as Record<string, unknown>)
          : (block.input ?? {}) as Record<string, unknown>;
        parts.push({ functionCall: { name: block.name, args } });
      } else if (block.type === "tool_result" && msg.role === "user") {
        // Gemini wants tool results in role:"function" content
        result.push({ role: "function", parts: [{ functionResponse: { name: block.toolUseId, response: { content: block.content } } }] });
        continue;
      }
    }
    if (parts.length > 0) result.push({ role, parts });
  }
  return result;
}

function extractSystemInstruction(messages: AgentMessage[]): string | undefined {
  const sys = messages.find((m) => m.role === "system");
  return sys && typeof sys.content === "string" ? sys.content : undefined;
}

function toGeminiTools(tools: ToolDefinition[]): { function_declarations: Array<{ name: string; description: string; parameters: unknown }> } {
  return {
    function_declarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };
}

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;

  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
  };
  const sys = extractSystemInstruction(messages);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  if (tools && tools.length > 0) body.tools = [toGeminiTools(tools)];
  if (config.maxTokens != null) body.generationConfig = { maxOutputTokens: config.maxTokens };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : "Failed to connect to Gemini API"}` };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      yield { type: "error", error: "Invalid Gemini API key" };
    } else if (response.status === 429) {
      yield { type: "error", error: "Gemini rate limit exceeded" };
    } else {
      yield { type: "error", error: `Gemini API error (${response.status}): ${text}` };
    }
    return;
  }

  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let toolCallIndex = 0;
  let stopReason: "end" | "tool_calls" | "length" | undefined;

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;
      try {
        const data = JSON.parse(sse.data);
        const candidate = data.candidates?.[0];
        if (!candidate) continue;
        const parts: GeminiPart[] = candidate.content?.parts ?? [];
        for (const p of parts) {
          if (p.text) {
            yield { type: "text-delta", text: p.text };
          } else if (p.functionCall) {
            const id = `gemini_call_${toolCallIndex}`;
            yield { type: "tool-call-start", id, index: toolCallIndex, name: p.functionCall.name };
            const argsJson = JSON.stringify(p.functionCall.args ?? {});
            if (argsJson !== "{}") yield { type: "tool-call-delta", index: toolCallIndex, argsDelta: argsJson };
            yield { type: "tool-call-end", index: toolCallIndex };
            toolCallIndex++;
            stopReason = "tool_calls";
          }
        }
        if (candidate.finishReason === "STOP" && stopReason !== "tool_calls") stopReason = "end";
        else if (candidate.finishReason === "MAX_TOKENS") stopReason = "length";
        if (data.usageMetadata) {
          usage = {
            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      } catch {
        // skip unparseable
      }
    }
    yield { type: "done", stopReason, usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}` };
  }
}

export const _toGeminiContentsForTest = toGeminiContents;
