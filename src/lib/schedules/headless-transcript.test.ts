import { describe, it, expect } from "vitest";
import { HeadlessTranscript } from "./headless-transcript";
import type { PortMessageToPanel } from "@/types";

const SID = "sess_1";

// Tiny builders so the tests read as a wire-event script.
const chunk = (text: string): PortMessageToPanel => ({ type: "chat-chunk", text, sessionId: SID });
const think = (text: string): PortMessageToPanel => ({ type: "thinking-chunk", text, sessionId: SID });
const done = (): PortMessageToPanel => ({ type: "chat-done", sessionId: SID });
const error = (msg: string): PortMessageToPanel => ({ type: "chat-error", error: msg, sessionId: SID });
const step = (
  stepIndex: number,
  tool: string,
  status: "pending" | "ok" | "error",
  observation?: string,
): PortMessageToPanel => ({
  type: "agent-step",
  stepIndex,
  tool,
  args: { foo: "bar" },
  status,
  ...(observation != null ? { observation } : {}),
  sessionId: SID,
});
const doneTask = (success: boolean, summary: string, stepCount: number): PortMessageToPanel => ({
  type: "agent-done-task",
  success,
  summary,
  stepCount,
  sessionId: SID,
});
const fileOut = (artifactId: string): PortMessageToPanel => ({
  type: "file-output",
  artifactId,
  filename: "out.txt",
  mime: "text/plain",
  size: 12,
  sessionId: SID,
});

describe("HeadlessTranscript", () => {
  it("seeds with the user prompt as the first message", () => {
    const t = new HeadlessTranscript("do the thing");
    expect(t.snapshot()).toEqual([{ role: "user", content: "do the thing" }]);
  });

  it("accumulates chat chunks and flushes one assistant message on chat-done", () => {
    const t = new HeadlessTranscript("hi");
    t.push(chunk("Hello"));
    t.push(chunk(" world"));
    t.push(done());
    expect(t.snapshot()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello world" },
    ]);
  });

  it("carries thinking text onto the flushed assistant message", () => {
    const t = new HeadlessTranscript("hi");
    t.push(think("let me think"));
    t.push(chunk("answer"));
    t.push(done());
    expect(t.snapshot()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "answer", thinking: "let me think" },
    ]);
  });

  it("snapshot flushes in-flight assistant text even without a terminal event", () => {
    const t = new HeadlessTranscript("hi");
    t.push(chunk("partial"));
    expect(t.snapshot()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "partial" },
    ]);
  });

  it("appends an agent-step entry, flushing any pending assistant text first", () => {
    const t = new HeadlessTranscript("hi");
    t.push(chunk("I will click"));
    t.push(step(0, "click", "pending"));
    expect(t.snapshot()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "I will click" },
      { role: "agent-step", stepIndex: 0, tool: "click", args: { foo: "bar" }, resolvedElement: undefined, status: "pending", observation: undefined },
    ]);
  });

  it("updates the trailing step in place when stepIndex+tool match (pending → ok)", () => {
    const t = new HeadlessTranscript("hi");
    t.push(step(0, "click", "pending"));
    t.push(step(0, "click", "ok", "clicked"));
    const snap = t.snapshot();
    // Only one step entry — the pending one was replaced, not duplicated.
    expect(snap.filter((m) => m.role === "agent-step")).toHaveLength(1);
    expect(snap[1]).toMatchObject({ role: "agent-step", stepIndex: 0, tool: "click", status: "ok", observation: "clicked" });
  });

  it("appends a new step entry when stepIndex differs", () => {
    const t = new HeadlessTranscript("hi");
    t.push(step(0, "click", "ok"));
    t.push(step(1, "type", "ok"));
    expect(t.snapshot().filter((m) => m.role === "agent-step")).toHaveLength(2);
  });

  it("appends an agent-summary on agent-done-task", () => {
    const t = new HeadlessTranscript("hi");
    t.push(doneTask(true, "all done", 3));
    expect(t.snapshot()).toEqual([
      { role: "user", content: "hi" },
      { role: "agent-summary", success: true, summary: "all done", stepCount: 3 },
    ]);
  });

  it("renders a realistic run: text → step → step → summary", () => {
    const t = new HeadlessTranscript("search for cats");
    t.push(think("plan"));
    t.push(chunk("Searching now"));
    t.push(step(0, "navigate", "pending"));
    t.push(step(0, "navigate", "ok", "loaded"));
    t.push(step(1, "read_page", "ok", "page text"));
    t.push(doneTask(true, "Found 3 cats", 2));
    const snap = t.snapshot();
    expect(snap.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "agent-step",
      "agent-step",
      "agent-summary",
    ]);
  });

  it("flushes pending assistant text on chat-error but records no error message (parity with port-handlers)", () => {
    const t = new HeadlessTranscript("hi");
    t.push(chunk("partial answer"));
    t.push(error("stream blew up"));
    const snap = t.snapshot();
    expect(snap).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "partial answer" },
    ]);
    // The error text is NOT injected as a fake assistant turn.
    expect(JSON.stringify(snap)).not.toContain("stream blew up");
  });

  it("appends a file-output card and de-dupes by artifactId", () => {
    const t = new HeadlessTranscript("make a file");
    t.push(fileOut("art_1"));
    t.push(fileOut("art_1")); // re-emit — must not double-card
    t.push(fileOut("art_2"));
    const cards = t.snapshot().filter((m) => m.role === "file-output");
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => (c as { artifactId: string }).artifactId)).toEqual(["art_1", "art_2"]);
  });

  it("ignores non-transcript events (agent-usage, needs-file-access)", () => {
    const t = new HeadlessTranscript("hi");
    t.push({ type: "agent-usage", lastInputTokens: 1, lastOutputTokens: 2, totalInputTokens: 1, totalOutputTokens: 2, sessionId: SID });
    t.push({ type: "needs-file-access" } as PortMessageToPanel);
    expect(t.snapshot()).toEqual([{ role: "user", content: "hi" }]);
  });

  it("snapshot returns a defensive copy (mutating it does not corrupt internal state)", () => {
    const t = new HeadlessTranscript("hi");
    const snap = t.snapshot();
    snap.push({ role: "assistant", content: "injected" });
    expect(t.snapshot()).toEqual([{ role: "user", content: "hi" }]);
  });
});
