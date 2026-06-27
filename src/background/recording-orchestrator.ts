/**
 * Recording v1 — SW 端 orchestrator.
 *
 * In-memory only：recordingState 是 Module-level Map<sessionId, RecordingSession>。
 * SW restart → state 全丢 → reconnect 时 panel 收不到 recording-state response →
 * 自动 abort（与 Fail-on-image 心智一致）。
 *
 * **Build-time invariant**（Unit 8 grep gate 验证）：本模块及其 import 树**绝不**调用
 * chrome.storage.local.set 把 RecordingSession 写出去。
 */

import type {
  RecordingStartMessage,
  RecordingActionMessage,
  RecordingFinishMessage,
  RecordingDiscardMessage,
  PortMessageToPanel,
} from "@/types";
import type { RecordedAction, RecordingSession, TabRegistry } from "@/lib/recording/types";
import { installCaptureListener } from "@/lib/recording/capture";
import { serialize, PromptTooLargeError } from "@/lib/recording/serialize";

const RESTRICTED_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "about:",
  "edge://",
  "file://",
  "data:",
  "javascript:",
  "blob:",
];

/** Module-level state: sessionId → RecordingSession. **In-memory only.** */
export const recordingState = new Map<string, RecordingSession>();

/** 把标签页纳入流程集合，分配/返回 tabRef（幂等）。registry 条目先占位，
 *  origin 待 recordFlowTabUrl 在 commit 时填。 */
export function registerFlowTab(sess: RecordingSession, tabId: number): number {
  const existing = sess.tabRefByTabId.get(tabId);
  if (existing !== undefined) return existing;
  const ref = sess.nextTabRef++;
  sess.tabRefByTabId.set(tabId, ref);
  if (!sess.tabRegistry[ref]) sess.tabRegistry[ref] = { origin: "", firstUrl: "" };
  return ref;
}

/** 标签页首次 commit 时填 registry 的 origin/firstUrl（只填一次，避免页内导航覆盖）。 */
export function recordFlowTabUrl(sess: RecordingSession, tabId: number, url: string): void {
  const ref = sess.tabRefByTabId.get(tabId);
  if (ref === undefined) return;
  const entry = sess.tabRegistry[ref];
  if (!entry || entry.origin) return; // already filled
  let origin = "";
  try {
    const o = new URL(url).origin;
    origin = !o || o === "null" ? "" : o;
  } catch {
    origin = "";
  }
  if (origin) sess.tabRegistry[ref] = { origin, firstUrl: url };
}

/** 从流程集合移除标签页，返回是否移除 + 集合是否已空。 */
export function removeFlowTab(
  sess: RecordingSession,
  tabId: number,
): { removed: boolean; empty: boolean } {
  const removed = sess.tabRefByTabId.delete(tabId);
  return { removed, empty: sess.tabRefByTabId.size === 0 };
}

function postToPanel(port: chrome.runtime.Port, msg: PortMessageToPanel) {
  try {
    port.postMessage(msg);
  } catch {
    // port closing — non-fatal
  }
}

function nextActionId() {
  return Date.now() + Math.random();
}

export async function handleRecordingStart(
  port: chrome.runtime.Port,
  msg: RecordingStartMessage,
  isStreaming?: (sessionId: string) => boolean,
): Promise<void> {
  if (recordingState.has(msg.sessionId)) {
    postToPanel(port, {
      type: "session-toast",
      level: "warn",
      text: "Recording already in progress for this session.",
      sessionId: msg.sessionId,
    });
    return;
  }

  // Belt-and-suspenders SW-side gate (panel-side gate is in App.tsx).
  if (isStreaming?.(msg.sessionId)) {
    postToPanel(port, {
      type: "session-toast",
      level: "warn",
      text: "Agent task in progress. Stop it before recording.",
      sessionId: msg.sessionId,
    });
    return;
  }

  let tab: chrome.tabs.Tab;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id || !activeTab.url) {
      postToPanel(port, {
        type: "session-toast",
        level: "warn",
        text: "No active tab to record.",
        sessionId: msg.sessionId,
      });
      return;
    }
    tab = activeTab;
  } catch (e) {
    postToPanel(port, {
      type: "session-toast",
      level: "error",
      text: `Failed to query active tab: ${e instanceof Error ? e.message : String(e)}`,
      sessionId: msg.sessionId,
    });
    return;
  }

  const url = tab.url!;
  if (RESTRICTED_URL_PREFIXES.some((p) => url.startsWith(p))) {
    postToPanel(port, {
      type: "session-toast",
      level: "warn",
      text: "Cannot record on this page (chrome://, file://, etc.).",
      sessionId: msg.sessionId,
    });
    return;
  }

  let origin: string;
  try {
    origin = new URL(url).origin;
    if (!origin || origin === "null") throw new Error("opaque origin");
  } catch {
    postToPanel(port, {
      type: "session-toast",
      level: "warn",
      text: "Cannot record on this URL (opaque origin).",
      sessionId: msg.sessionId,
    });
    return;
  }

  const session: RecordingSession = {
    sessionId: msg.sessionId,
    tabId: tab.id!,
    origin,
    startedAt: Date.now(),
    tabRefByTabId: new Map([[tab.id!, 0]]),
    nextTabRef: 1,
    tabRegistry: { 0: { origin, firstUrl: url } },
    actions: [],
  };
  recordingState.set(msg.sessionId, session);

  try {
    await injectCapture(tab.id!);
  } catch (e) {
    recordingState.delete(msg.sessionId);
    postToPanel(port, {
      type: "session-toast",
      level: "error",
      text: `Cannot record on this page (page security restrictions): ${e instanceof Error ? e.message : String(e)}`,
      sessionId: msg.sessionId,
    });
    postToPanel(port, {
      type: "recording-aborted",
      sessionId: msg.sessionId,
      reason: "csp-blocked",
    });
    return;
  }

  postToPanel(port, {
    type: "recording-started",
    sessionId: msg.sessionId,
    tabId: tab.id!,
    origin,
    startedAt: session.startedAt,
  });
}

async function injectCapture(tabId: number): Promise<void> {
  // Inject in the default ISOLATED world (chrome.runtime.sendMessage requires it).
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: installCaptureListener,
  });
}

function findSessionByTabId(tabId: number | undefined): RecordingSession | null {
  if (tabId === undefined) return null;
  for (const sess of recordingState.values()) {
    if (sess.tabRefByTabId.has(tabId)) return sess;
  }
  return null;
}

export function handleRecordingAction(
  sender: chrome.runtime.MessageSender,
  msg: RecordingActionMessage,
  port?: chrome.runtime.Port,
): void {
  const sess = findSessionByTabId(sender.tab?.id);
  if (!sess) return;

  const action: RecordedAction = {
    ...msg.payload,
    tabRef: sess.tabRefByTabId.get(sender.tab?.id ?? -1),
    timestamp: nextActionId(),
  };
  sess.actions.push(action);

  if (port) {
    postToPanel(port, {
      type: "recording-action-broadcast",
      sessionId: sess.sessionId,
      action,
    });
  }
}

/**
 * Reframe (2026-05-05)：handleRecordingFinish 不再 saveSkill。
 * 改为：serialize trace → broadcast `recording-finished {serializedTrace, stepCount}` → clear state。
 * Panel 收到后注入 chat 输入框 chip，user 加 prompt 后 Send 时 prefix
 * `/create_skill_from_recording` slash 命令，让 LLM 看 trace + user prompt
 * 后调 create_skill meta tool（走 R10 first-run confirm 卡片作为 capability
 * review surface）。
 *
 * SW 端只负责 trace 序列化 + 8KB 上限校验；不再做 allowedTools / quota /
 * SkillDefinition 构建——这些都由 LLM 决定 + skill-meta.ts handler enforce。
 */
export async function handleRecordingFinish(
  port: chrome.runtime.Port,
  msg: RecordingFinishMessage,
): Promise<void> {
  const sess = recordingState.get(msg.sessionId);
  if (!sess) {
    postToPanel(port, {
      type: "session-toast",
      level: "warn",
      text: "No recording in progress.",
      sessionId: msg.sessionId,
    });
    return;
  }

  if (sess.actions.length === 0) {
    postToPanel(port, {
      type: "session-toast",
      level: "warn",
      text: "Recording is empty — operate the page first, or click Discard.",
      sessionId: msg.sessionId,
    });
    return;
  }

  let serialized;
  try {
    serialized = serialize(sess.actions, sess.tabRegistry);
  } catch (e) {
    if (e instanceof PromptTooLargeError) {
      postToPanel(port, {
        type: "session-toast",
        level: "error",
        text: `Recording too long (${e.actualBytes}/${e.maxBytes} bytes). Discard and re-record a shorter flow.`,
        sessionId: msg.sessionId,
      });
      return;
    }
    throw e;
  }

  recordingState.delete(msg.sessionId);
  postToPanel(port, {
    type: "recording-finished",
    sessionId: msg.sessionId,
    serializedTrace: serialized.promptTemplate,
    stepCount: sess.actions.length,
  });
}

export async function handleRecordingDiscard(
  port: chrome.runtime.Port,
  msg: RecordingDiscardMessage,
): Promise<void> {
  abortRecordingForSession(port, msg.sessionId, "user-discard");
}

export function abortRecordingForSession(
  port: chrome.runtime.Port,
  sessionId: string,
  reason: "sw-restart" | "session-switched" | "panel-disconnect" | "tab-closed" | "csp-blocked" | "user-discard",
): void {
  if (!recordingState.has(sessionId)) return;
  recordingState.delete(sessionId);
  postToPanel(port, { type: "recording-aborted", sessionId, reason });
}

/** opener ∈ 某 session 流程集合的新标签页（含跨窗口）→ 纳入该 session 流程集合。
 *  capture 注入推迟到该标签页首次 onCommitted（避开 about:blank 被冲掉）。 */
export function handleRecordingTabCreated(tab: chrome.tabs.Tab): RecordingSession | null {
  const opener = tab.openerTabId;
  if (opener === undefined || tab.id === undefined) return null;
  for (const sess of recordingState.values()) {
    if (sess.tabRefByTabId.has(opener)) {
      registerFlowTab(sess, tab.id);
      return sess;
    }
  }
  return null;
}

export function handleRecordingTabClosed(port: chrome.runtime.Port, closedTabId: number): void {
  for (const sess of Array.from(recordingState.values())) {
    if (!sess.tabRefByTabId.has(closedTabId)) continue;
    const { empty } = removeFlowTab(sess, closedTabId);
    if (empty) abortRecordingForSession(port, sess.sessionId, "tab-closed");
  }
}

export async function handleRecordingNavCommitted(
  port: chrome.runtime.Port,
  details: { tabId: number; url: string; frameId: number },
): Promise<void> {
  if (details.frameId !== 0) return;
  const sess = findSessionByTabId(details.tabId);
  if (!sess) return;

  // window.open('about:blank') / popup placeholders commit to about:blank first,
  // then navigate to the real url. This transient blank is NOT a navigation to a
  // restricted page — skip it and wait for the real url's onCommitted, else the
  // whole flow aborts (OAuth/payment popups use exactly this pattern).
  if (details.url === "about:blank") return;

  if (RESTRICTED_URL_PREFIXES.some((p) => details.url.startsWith(p))) {
    abortRecordingForSession(port, sess.sessionId, "csp-blocked");
    return;
  }

  const action: RecordedAction = {
    type: "navigate",
    label: "navigate",
    url: details.url,
    region: "other",
    timestamp: nextActionId(),
  };
  sess.actions.push(action);
  postToPanel(port, {
    type: "recording-action-broadcast",
    sessionId: sess.sessionId,
    action,
  });

  recordFlowTabUrl(sess, details.tabId, details.url);
  try {
    await injectCapture(details.tabId);
  } catch {
    abortRecordingForSession(port, sess.sessionId, "csp-blocked");
  }
}

export async function handleRecordingHistoryStateUpdated(
  port: chrome.runtime.Port,
  details: { tabId: number; url: string; frameId: number },
): Promise<void> {
  if (details.frameId !== 0) return;
  const sess = findSessionByTabId(details.tabId);
  if (!sess) return;

  const action: RecordedAction = {
    type: "navigate",
    label: "navigate (SPA)",
    url: details.url,
    region: "other",
    timestamp: nextActionId(),
  };
  sess.actions.push(action);
  postToPanel(port, {
    type: "recording-action-broadcast",
    sessionId: sess.sessionId,
    action,
  });
}
