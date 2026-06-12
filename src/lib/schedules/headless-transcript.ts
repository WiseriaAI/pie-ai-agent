// src/lib/schedules/headless-transcript.ts
//
// Headless schedule runs have no side-panel, so nothing builds the
// panel-renderable DisplayMessage[] that setActive() hydrates from
// `meta.messages`. That is exactly why opening a finished run from the run
// history used to show a blank conversation: run.ts only persisted the agent IR
// snapshot (setSessionAgent), never `meta.messages`.
//
// This accumulator folds the SAME emit stream the foreground port-handlers
// consume into a DisplayMessage[] that run.ts persists to `meta.messages`, so a
// scheduled run renders just like a normal chat. The display semantics MIRROR
// `src/sidepanel/hooks/useSession/port-handlers.ts` (the foreground source of
// truth) so a headless run and a foreground run look identical when reopened:
//   - assistant text/thinking accumulate until a terminal/step event flushes
//     them into a single { role: "assistant" } message;
//   - agent-step appends, or replaces the matching trailing step in place
//     (same stepIndex+tool) so a pending→ok transition doesn't duplicate;
//   - agent-done-task appends an { role: "agent-summary" };
//   - chat-error flushes pending text but injects NO message (the foreground
//     keeps the error in transient slot.error, never in meta.messages — the
//     failure is conveyed by the agent-summary instead);
//   - file-output appends a download card, de-duped by artifactId.
//
// agent-step `image` bytes are wire-only / display-only (never persisted, see
// the type contract in types/messages.ts), so they are dropped here.

import type { DisplayMessage, PortMessageToPanel } from "@/types";

export class HeadlessTranscript {
  private messages: DisplayMessage[] = [];
  private accumulated = "";
  private thinking = "";

  constructor(userPrompt: string) {
    this.messages.push({ role: "user", content: userPrompt });
  }

  /** Commit any pending assistant text/thinking into a single message. */
  private flushAssistant(): void {
    if (!this.accumulated.trim() && !this.thinking.trim()) return;
    this.messages.push({
      role: "assistant",
      content: this.accumulated,
      ...(this.thinking.trim() ? { thinking: this.thinking } : {}),
    });
    this.accumulated = "";
    this.thinking = "";
  }

  /** Fold one emitted wire message into the transcript. */
  push(msg: PortMessageToPanel): void {
    switch (msg.type) {
      case "chat-chunk":
        this.accumulated += msg.text;
        return;
      case "thinking-chunk":
        this.thinking += msg.text;
        return;
      case "chat-done":
        this.flushAssistant();
        return;
      case "chat-error":
        // Parity with port-handlers: flush partial text, but the error itself
        // is NOT a message (the agent-summary conveys failure).
        this.flushAssistant();
        return;
      case "agent-step": {
        this.flushAssistant();
        const entry: DisplayMessage = {
          role: "agent-step",
          stepIndex: msg.stepIndex,
          tool: msg.tool,
          args: msg.args,
          resolvedElement: msg.resolvedElement,
          status: msg.status,
          observation: msg.observation,
        };
        const tail = this.messages.length - 1;
        const last = tail >= 0 ? this.messages[tail] : null;
        if (
          last &&
          last.role === "agent-step" &&
          last.stepIndex === msg.stepIndex &&
          last.tool === msg.tool
        ) {
          this.messages[tail] = entry;
        } else {
          this.messages.push(entry);
        }
        return;
      }
      case "agent-done-task":
        this.flushAssistant();
        this.messages.push({
          role: "agent-summary",
          success: msg.success,
          summary: msg.summary,
          stepCount: msg.stepCount,
        });
        return;
      case "file-output": {
        const exists = this.messages.some(
          (m) => m.role === "file-output" && m.artifactId === msg.artifactId,
        );
        if (exists) return;
        this.messages.push({
          role: "file-output",
          artifactId: msg.artifactId,
          filename: msg.filename,
          mime: msg.mime,
          size: msg.size,
        });
        return;
      }
      default:
        // agent-usage / needs-file-access / session-* / quote-added /
        // recording-* / chat-instruction-* — not part of the rendered
        // transcript.
        return;
    }
  }

  /**
   * Current renderable messages. Flushes any in-flight assistant text so a
   * mid-run snapshot is coherent, and returns a defensive copy so callers
   * can't mutate internal state.
   */
  snapshot(): DisplayMessage[] {
    this.flushAssistant();
    return this.messages.slice();
  }
}
