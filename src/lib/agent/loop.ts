import type { ModelConfig, AgentMessage, ContentBlock, ToolDefinition } from "../model-router/types";
import { streamChat } from "../model-router";
import { snapshotInteractiveElements } from "../dom-actions/snapshot";
import type { PageSnapshot } from "../dom-actions/types";
import {
  BUILT_IN_TOOLS,
  getKeyboardTools,
  isKeyboardToolName,
} from "./tools";
import type { Tool } from "./types";
import { classifyRisk } from "./risk";
import { buildAgentSystemPrompt, buildObservationMessage } from "./prompt";
import { applySlidingWindow } from "./window";
import { isKeyboardSimulationEnabled } from "../keyboard-simulation";
import {
  acquireCdpSession,
  type CdpSession,
} from "../../background/cdp-session";
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

// ── Phase 2.5 helpers ────────────────────────────────────────────────────────

/**
 * Redact `text` from keyboard tool args before emitting via agent-step
 * (event-card path). Confirm-request keeps the raw text — see plan
 * Key Technical Decisions on the redaction split.
 */
function redactArgsForPanel(toolName: string, args: unknown): unknown {
  if (!isKeyboardToolName(toolName)) return args;
  if (!args || typeof args !== "object") return args;
  const a = args as Record<string, unknown>;
  if (typeof a.text !== "string") return args;
  return {
    ...a,
    text: undefined,
    _redactedTextLength: (a.text as string).length,
  };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runAgentLoop(ctx: AgentLoopContext): Promise<void> {
  const { port, task, modelConfig, sendConfirmRequest, getEnabledSkillTools } = ctx;

  // Phase 2.5 lifecycle plumbing.
  //
  // We chain the caller's signal to a fresh internal AbortController so
  // we can abort the loop programmatically (yellow-bar cancel, storage
  // kill-switch). The caller's signal still controls — its abort fires
  // ours via the listener; our abort doesn't bubble back.
  const internalController = new AbortController();
  if (ctx.signal.aborted) {
    internalController.abort();
  } else {
    ctx.signal.addEventListener(
      "abort",
      () => internalController.abort(),
      { once: true },
    );
  }
  const signal = internalController.signal;

  const ownerToken = crypto.randomUUID();
  let cdpSession: CdpSession | null = null;
  let doneEmitted = false;
  let lastStepIndex = 0;
  let normalTextReply = false; // pure-text reply uses chat-done, not agent-done-task

  // Idempotent done emit — every runAgentLoop exit path (success, abort,
  // error, finally) calls this; first one wins, the rest are no-ops.
  const emitDone = (msg: AgentDoneTaskMessage): void => {
    if (doneEmitted) return;
    doneEmitted = true;
    sendAgentDone(port, msg);
  };

  // 1. Anchor tab + origin at task start
  let pinnedTabId: number;
  let pinnedOrigin: string;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) {
      emitDone({
        type: "agent-done-task",
        success: false,
        summary: "Cannot run agent on this page type",
        stepCount: 0,
      });
      return;
    }
    const origin = safeParseOrigin(tab.url);
    if (!origin) {
      emitDone({
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
    emitDone({
      type: "agent-done-task",
      success: false,
      summary: "Failed to get active tab",
      stepCount: 0,
    });
    return;
  }

  // Curried CdpSession factory — passed to keyboard tools via closure.
  // INVARIANT: defined ONCE here, BEFORE the for-loop, so all per-iteration
  // tool builds share the same outer cdpSession variable. Moving this
  // inside the loop would make each round's handler closures capture a
  // fresh local, breaking lazy-attach semantics (every keyboard call
  // would re-attach → yellow bar flicker + leaks).
  const acquireSessionForTask = async (
    tabId: number,
  ): Promise<CdpSession> => {
    const session = await acquireCdpSession(tabId, {
      signal,
      ownerToken,
      onExternalDetach: () => {
        // Yellow bar cancel / storage kill-switch — propagate the abort
        // so the loop exits via signal.aborted check, falls through to
        // finally, which emits agent-done-task with reason-based summary.
        internalController.abort();
      },
    });
    if (!cdpSession) cdpSession = session;
    return session;
  };

  // Read keyboard sim flag at task start. Tool list is re-resolved each
  // iteration (so toggling ON mid-task adds tools next round; toggling
  // OFF triggers kill-switch + abort).
  const keyboardSimEnabledAtStart = await isKeyboardSimulationEnabled();

  // 2. Initial history
  // Structure: [system, user(initial-task)]
  // Per turn: assistant(tool_use blocks) + user([tool_result blocks..., text(observation)])
  // The observation is MERGED into the same user message as the prior turn's tool_results
  // to avoid adjacent user messages (which Anthropic rejects with 400).
  const history: AgentMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt(task, keyboardSimEnabledAtStart),
    },
    { role: "user", content: task },
  ];

  // First-attach disclosure — true until the first keyboard-tool confirm
  // has been shown. After that, subsequent confirms in the same task
  // skip the debugger-activation preamble (yellow bar already visible).
  let firstKeyboardConfirmShown = false;

  try {
    for (let stepIndex = 1; stepIndex <= MAX_STEPS; stepIndex++) {
      lastStepIndex = stepIndex;
      if (signal.aborted) return; // → finally

      // Origin check
      let currentUrl: string;
      try {
        const currentTab = await chrome.tabs.get(pinnedTabId);
        if (!currentTab.url || isRestrictedUrl(currentTab.url)) {
          emitDone({
            type: "agent-done-task",
            success: false,
            summary: "Page navigated to a restricted URL, agent stopped",
            stepCount: stepIndex - 1,
          });
          return;
        }
        const currentOrigin = safeParseOrigin(currentTab.url);
        if (!currentOrigin || currentOrigin !== pinnedOrigin) {
          emitDone({
            type: "agent-done-task",
            success: false,
            summary: "Page origin changed, agent stopped for safety",
            stepCount: stepIndex - 1,
          });
          return;
        }
        currentUrl = currentTab.url;
      } catch {
        emitDone({
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
        emitDone({
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

      // Resolve tools — re-read keyboard sim flag every iteration so
      // mid-task ON adds tools next round (mid-task OFF is handled by
      // the kill-switch in background/index.ts which detaches + aborts).
      const skillTools = getEnabledSkillTools ? await getEnabledSkillTools() : [];
      const currentKeyboardEnabled = await isKeyboardSimulationEnabled();
      const keyboardTools = currentKeyboardEnabled
        ? getKeyboardTools({
            acquireSession: acquireSessionForTask,
            pinnedOrigin,
          })
        : [];
      const allTools = [...BUILT_IN_TOOLS, ...skillTools, ...keyboardTools];
      const toolDefinitions = toolsToDefinitions(allTools);

      // Stream from LLM
      let accumulatedText = "";
      const openToolCalls = new Map<
        number,
        { id: string; name: string; argsAccum: string }
      >();
      const completedToolCalls: Array<{ id: string; name: string; args: unknown }> = [];

      for await (const event of streamChat(modelConfig, windowedHistory, signal, toolDefinitions)) {
        if (signal.aborted) return; // → finally

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
          emitDone({
            type: "agent-done-task",
            success: false,
            summary: `LLM stream error: ${event.error}`,
            stepCount: stepIndex,
          });
          return;
        }
      }

      // If abort fired during streaming, providers silently return from
      // the generator (no throw). Detect that here BEFORE treating an
      // empty completedToolCalls as a normal pure-text reply — otherwise
      // an aborted stream looks like "LLM ended cleanly" and finally
      // skips its done emit (because normalTextReply gates it).
      if (signal.aborted) return; // → finally with reason-based summary

      // Pure text response (no tool calls) — finish as normal chat
      if (completedToolCalls.length === 0) {
        port.postMessage({ type: "chat-done" });
        normalTextReply = true;
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
            args: redactArgsForPanel(tc.name, tc.args),
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
          args: redactArgsForPanel(tc.name, tc.args),
          resolvedElement,
          status: "pending",
        });

        // Risk classification
        const risk = classifyRisk(tc.name, args as { elementIndex?: number; value?: string }, snapshot);

        if (risk.level === "high") {
          const confirmationId = crypto.randomUUID();

          // Build confirm reason — keyboard tools' first call gets a
          // debugger-activation disclosure prepended.
          let riskReason = risk.reason ?? "High risk operation";
          if (
            isKeyboardToolName(tc.name) &&
            !firstKeyboardConfirmShown &&
            !cdpSession
          ) {
            riskReason =
              "First keyboard-simulation call — Chrome debugger will activate (yellow bar) for the rest of this task. Cancel by clicking the yellow bar, ending the task, or toggling Settings off.\n\n" +
              riskReason;
            firstKeyboardConfirmShown = true;
          }

          // confirm-request keeps RAW args.text — user must see the
          // actual content to make an informed approval. agent-step
          // (above + below) uses redactArgsForPanel.
          const approved = await sendConfirmRequest(confirmationId, {
            tool: tc.name,
            args: tc.args,
            resolvedElement: resolvedElement ?? { text: "", tag: "" },
            riskReason,
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
              args: redactArgsForPanel(tc.name, tc.args),
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

        let observation = result.observation ?? result.error ?? "";

        // Phase 2.5: when type tool reports IME buffer error and
        // keyboard simulation is OFF, append a hint pointing user to
        // Settings. Skipped when sim is ON (LLM should retry via
        // dispatch_keyboard_input on its own per system prompt).
        if (
          tc.name === "type" &&
          !result.success &&
          observation.includes("hidden IME / keyboard capture buffer") &&
          !currentKeyboardEnabled
        ) {
          observation +=
            "\n(Tip: enable 'Keyboard simulation' in Settings to handle this case via CDP.)";
        }

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
          args: redactArgsForPanel(tc.name, tc.args),
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
        emitDone({
          type: "agent-done-task",
          success: terminationResult.success,
          summary: terminationResult.summary,
          stepCount: stepIndex,
        });
        return;
      }
    }

    // Max steps exceeded
    emitDone({
      type: "agent-done-task",
      success: false,
      summary: "Max steps reached",
      stepCount: MAX_STEPS,
    });
  } finally {
    // Always tear down any CDP session this task acquired. Idempotent —
    // signal abort listener inside cdp-session.ts may have already done
    // it, but calling again is a no-op.
    if (cdpSession) {
      try {
        await cdpSession.detach();
      } catch {
        // best-effort cleanup; nothing useful to do on detach failure
      }
    }

    // If we exited without emitting agent-done-task (signal-abort path,
    // or unexpected throw before any emit), emit one with a reason-based
    // summary. Pure-text replies skip this — they use chat-done.
    if (!doneEmitted && !normalTextReply) {
      const reason = cdpSession?.detachedReason ?? null;
      let summary: string;
      switch (reason) {
        case "user-cancelled-via-yellow-bar":
          summary = "用户取消了调试授权";
          break;
        case "kill-switch":
          summary = "用户在 Settings 关闭了键盘模拟";
          break;
        case "tab-closed":
          summary = "标签页已关闭";
          break;
        default:
          summary = "任务已取消";
          break;
      }
      emitDone({
        type: "agent-done-task",
        success: false,
        summary,
        stepCount: lastStepIndex,
      });
    }
  }
}
