import type { ModelConfig, AgentMessage, ContentBlock, ToolDefinition } from "../model-router/types";
import { streamChat } from "../model-router";
import { snapshotInteractiveElements } from "../dom-actions/snapshot";
import type { PageSnapshot } from "../dom-actions/types";
import { BUILT_IN_TOOLS } from "./tools";
import type { Tool } from "./types";
import { classifyRisk } from "./risk";
import { buildAgentSystemPrompt, buildObservationMessage } from "./prompt";
import { applySlidingWindow } from "./window";
import type {
  AgentStepMessage,
  AgentConfirmRequestMessage,
  AgentDoneTaskMessage,
  ResolvedElement,
} from "../../types/messages";

const MAX_STEPS = 30;

export interface AgentLoopContext {
  port: chrome.runtime.Port;
  task: string;
  modelConfig: ModelConfig;
  signal: AbortSignal;
  sendConfirmRequest: (
    confirmationId: string,
    payload: Omit<AgentConfirmRequestMessage, "type" | "confirmationId">,
  ) => Promise<boolean>;
  getEnabledSkillTools?: () => Promise<Tool[]>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toolsToDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

function resolveElement(
  snapshot: PageSnapshot,
  elementIndex: unknown,
): ResolvedElement | undefined {
  if (typeof elementIndex !== "number") return undefined;
  const el = snapshot.elements.find((e) => e.index === elementIndex);
  if (!el) return undefined;
  return {
    text: el.text,
    ariaLabel: el.ariaLabel,
    tag: el.tag,
    type: el.type,
    // ElementInfo does not have href; leave undefined
  };
}

function sendAgentStep(
  port: chrome.runtime.Port,
  msg: AgentStepMessage,
): void {
  port.postMessage(msg);
}

function sendAgentDone(
  port: chrome.runtime.Port,
  msg: AgentDoneTaskMessage,
): void {
  port.postMessage(msg);
}

function isRestrictedUrl(url: string): boolean {
  // Reject schemes whose origin collapses to the string "null" or that the agent
  // has no sensible way to pin: file://, data:, javascript:, blob:. Without these
  // checks, any subsequent navigation within one of these schemes would pass the
  // per-round origin comparison (`"null" === "null"`), defeating the isolation.
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("file://") ||
    url.startsWith("data:") ||
    url.startsWith("javascript:") ||
    url.startsWith("blob:")
  );
}

export function safeParseOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    // Opaque origins parse to the literal string "null"; treat them as unresolvable.
    if (!origin || origin === "null") return null;
    return origin;
  } catch {
    return null;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runAgentLoop(ctx: AgentLoopContext): Promise<void> {
  const { port, task, modelConfig, signal, sendConfirmRequest, getEnabledSkillTools } = ctx;

  // 1. Anchor tab + origin at task start
  let pinnedTabId: number;
  let pinnedOrigin: string;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) {
      sendAgentDone(port, {
        type: "agent-done-task",
        success: false,
        summary: "Cannot run agent on this page type",
        stepCount: 0,
      });
      return;
    }
    const origin = safeParseOrigin(tab.url);
    if (!origin) {
      sendAgentDone(port, {
        type: "agent-done-task",
        success: false,
        summary: "Cannot run agent on this page (unresolvable origin)",
        stepCount: 0,
      });
      return;
    }
    pinnedTabId = tab.id;
    pinnedOrigin = origin;
  } catch {
    sendAgentDone(port, {
      type: "agent-done-task",
      success: false,
      summary: "Failed to get active tab",
      stepCount: 0,
    });
    return;
  }

  // 2. Initial history
  // Structure: [system, user(initial-task)]
  // Per turn: assistant(tool_use blocks) + user([tool_result blocks..., text(observation)])
  // The observation is MERGED into the same user message as the prior turn's tool_results
  // to avoid adjacent user messages (which Anthropic rejects with 400).
  const history: AgentMessage[] = [
    { role: "system", content: buildAgentSystemPrompt(task) },
    { role: "user", content: task },
  ];

  // 3. ReAct loop
  for (let stepIndex = 1; stepIndex <= MAX_STEPS; stepIndex++) {
    if (signal.aborted) return;

    // Origin check
    let currentUrl: string;
    try {
      const currentTab = await chrome.tabs.get(pinnedTabId);
      if (!currentTab.url || isRestrictedUrl(currentTab.url)) {
        sendAgentDone(port, {
          type: "agent-done-task",
          success: false,
          summary: "Page navigated to a restricted URL, agent stopped",
          stepCount: stepIndex - 1,
        });
        return;
      }
      const currentOrigin = safeParseOrigin(currentTab.url);
      if (!currentOrigin || currentOrigin !== pinnedOrigin) {
        sendAgentDone(port, {
          type: "agent-done-task",
          success: false,
          summary: "Page origin changed, agent stopped for safety",
          stepCount: stepIndex - 1,
        });
        return;
      }
      currentUrl = currentTab.url;
    } catch {
      sendAgentDone(port, {
        type: "agent-done-task",
        success: false,
        summary: "Tab was closed, agent stopped",
        stepCount: stepIndex - 1,
      });
      return;
    }

    // Snapshot the page
    let snapshot: PageSnapshot;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: pinnedTabId },
        func: snapshotInteractiveElements,
      });
      snapshot = (results[0]?.result as PageSnapshot) ?? { url: currentUrl, title: "", elements: [] };
    } catch {
      sendAgentDone(port, {
        type: "agent-done-task",
        success: false,
        summary: "Failed to snapshot page. The page may have navigated.",
        stepCount: stepIndex - 1,
      });
      return;
    }

    // Build observation text
    const observationText = buildObservationMessage(snapshot, currentUrl);
    const observationBlock: ContentBlock = { type: "text", text: observationText };

    // Merge the observation into the last user message to avoid adjacent same-role messages.
    // Anthropic's Messages API requires strict user/assistant alternation (400 on violation).
    //
    // Cases:
    //  Step 1: history = [system, user(task-string)]
    //    → convert trailing user to array: user([text(task), obs])
    //  Step N>1: history = [..., assistant(tool_use), user([tool_results...])]
    //    → append obs block: user([tool_results..., obs])
    const lastMsg = history[history.length - 1];
    if (lastMsg && lastMsg.role === "user") {
      if (typeof lastMsg.content === "string") {
        // Convert string content to block array, prepend task text, append observation
        const taskText = lastMsg.content;
        lastMsg.content = [
          { type: "text", text: taskText },
          observationBlock,
        ] as ContentBlock[];
      } else {
        // Already an array (tool_result blocks from prior step) — append observation
        (lastMsg.content as ContentBlock[]).push(observationBlock);
      }
    } else {
      // Shouldn't happen in normal flow, but guard just in case
      history.push({ role: "user", content: [observationBlock] });
    }

    // Apply sliding window
    const windowedHistory = applySlidingWindow(history);

    // Resolve tools
    const skillTools = getEnabledSkillTools ? await getEnabledSkillTools() : [];
    const allTools = [...BUILT_IN_TOOLS, ...skillTools];
    const toolDefinitions = toolsToDefinitions(allTools);

    // Stream from LLM
    let accumulatedText = "";
    const openToolCalls = new Map<
      number,
      { id: string; name: string; argsAccum: string }
    >();
    const completedToolCalls: Array<{ id: string; name: string; args: unknown }> = [];

    for await (const event of streamChat(modelConfig, windowedHistory, signal, toolDefinitions)) {
      if (signal.aborted) return;

      if (event.type === "text-delta") {
        accumulatedText += event.text;
        // Stream text to panel as it arrives (Phase 1 compatible)
        port.postMessage({ type: "chat-chunk", text: event.text });
      } else if (event.type === "tool-call-start") {
        openToolCalls.set(event.index, {
          id: event.id,
          name: event.name,
          argsAccum: "",
        });
      } else if (event.type === "tool-call-delta") {
        const pending = openToolCalls.get(event.index);
        if (pending) {
          pending.argsAccum += event.argsDelta;
        }
      } else if (event.type === "tool-call-end") {
        const pending = openToolCalls.get(event.index);
        if (pending) {
          let parsedArgs: unknown = {};
          try {
            parsedArgs = pending.argsAccum ? JSON.parse(pending.argsAccum) : {};
          } catch {
            parsedArgs = {};
          }
          completedToolCalls.push({
            id: pending.id,
            name: pending.name,
            args: parsedArgs,
          });
          openToolCalls.delete(event.index);
        }
      } else if (event.type === "error") {
        port.postMessage({ type: "chat-error", error: event.error });
        return;
      }
    }

    // Pure text response (no tool calls) — finish as normal chat
    if (completedToolCalls.length === 0) {
      port.postMessage({ type: "chat-done" });
      return;
    }

    // Build the assistant message with all tool_use blocks (+ optional text block)
    const assistantBlocks: ContentBlock[] = [];
    if (accumulatedText) {
      assistantBlocks.push({ type: "text", text: accumulatedText });
    }
    for (const tc of completedToolCalls) {
      assistantBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.args,
      });
    }

    // Collect tool_result blocks for the user turn
    const toolResultBlocks: ContentBlock[] = [];
    let shouldTerminate = false;
    let terminationResult: { success: boolean; summary: string } | null = null;

    // Process each tool call in order
    for (const tc of completedToolCalls) {
      const args = tc.args as Record<string, unknown>;
      const tool = allTools.find((t) => t.name === tc.name);

      if (!tool) {
        const errorMsg = `Unknown tool: ${tc.name}`;
        toolResultBlocks.push({
          type: "tool_result",
          toolUseId: tc.id,
          content: errorMsg,
          isError: true,
        });
        sendAgentStep(port, {
          type: "agent-step",
          stepIndex,
          tool: tc.name,
          args: tc.args,
          status: "error",
          observation: errorMsg,
        });
        continue;
      }

      // Resolve element for confirmation / display
      const resolvedElement = resolveElement(snapshot, args.elementIndex);

      // Send pending step
      sendAgentStep(port, {
        type: "agent-step",
        stepIndex,
        tool: tc.name,
        args: tc.args,
        resolvedElement,
        status: "pending",
      });

      // Risk classification
      const risk = classifyRisk(tc.name, args as { elementIndex?: number; value?: string }, snapshot);

      if (risk.level === "high") {
        const confirmationId = crypto.randomUUID();
        const approved = await sendConfirmRequest(confirmationId, {
          tool: tc.name,
          args: tc.args,
          resolvedElement: resolvedElement ?? { text: "", tag: "" },
          riskReason: risk.reason ?? "High risk operation",
        });

        if (!approved) {
          const rejectionMsg = "User rejected";
          toolResultBlocks.push({
            type: "tool_result",
            toolUseId: tc.id,
            content: rejectionMsg,
            isError: true,
          });
          sendAgentStep(port, {
            type: "agent-step",
            stepIndex,
            tool: tc.name,
            args: tc.args,
            resolvedElement,
            status: "error",
            observation: rejectionMsg,
          });
          continue;
        }
      }

      // Execute tool
      let result;
      try {
        result = await tool.handler(tc.args, { tabId: pinnedTabId, snapshot });
      } catch (e) {
        result = {
          success: false,
          error: e instanceof Error ? e.message : "Tool execution failed",
        };
      }

      const observation = result.observation ?? result.error ?? "";
      toolResultBlocks.push({
        type: "tool_result",
        toolUseId: tc.id,
        content: observation,
        isError: !result.success,
      });

      sendAgentStep(port, {
        type: "agent-step",
        stepIndex,
        tool: tc.name,
        args: tc.args,
        resolvedElement,
        status: result.success ? "ok" : "error",
        observation,
      });

      // Check for terminal tools
      if (tc.name === "done" && result.success) {
        shouldTerminate = true;
        terminationResult = { success: true, summary: observation };
      } else if (tc.name === "fail") {
        shouldTerminate = true;
        terminationResult = { success: false, summary: result.error ?? observation };
      }
    }

    // Push assistant message + user tool_result message into history.
    // The observation for the NEXT step will be appended to this user message
    // at the start of the next iteration (avoids adjacent user messages).
    history.push({ role: "assistant", content: assistantBlocks });
    history.push({ role: "user", content: toolResultBlocks });

    // Terminal tool check
    if (shouldTerminate && terminationResult) {
      sendAgentDone(port, {
        type: "agent-done-task",
        success: terminationResult.success,
        summary: terminationResult.summary,
        stepCount: stepIndex,
      });
      return;
    }
  }

  // Max steps exceeded
  sendAgentDone(port, {
    type: "agent-done-task",
    success: false,
    summary: "Max steps reached",
    stepCount: MAX_STEPS,
  });
}
