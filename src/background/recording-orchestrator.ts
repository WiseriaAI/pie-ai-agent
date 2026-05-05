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
import type { RecordedAction, RecordingSession } from "@/lib/recording/types";
import { installCaptureListener } from "@/lib/recording/capture";
import { serialize, PromptTooLargeError } from "@/lib/recording/serialize";
import { saveSkill, generateUserSkillId, getSkillStorageBytes } from "@/lib/skills/storage";
import type { SkillDefinition } from "@/lib/skills/types";
import { ALL_KNOWN_NON_SKILL_TOOL_NAMES } from "@/lib/agent/tool-names";

function countAllStringChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countAllStringChars(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    let total = 0;
    for (const v of Object.values(value as Record<string, unknown>)) total += countAllStringChars(v);
    return total;
  }
  return 0;
}

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

const SKILL_STORAGE_QUOTA_BYTES = 1 * 1024 * 1024;

/** Module-level state: sessionId → RecordingSession. **In-memory only.** */
export const recordingState = new Map<string, RecordingSession>();

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
    if (sess.tabId === tabId) return sess;
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

  if (!msg.skillName.trim() || !msg.skillDescription.trim()) {
    postToPanel(port, {
      type: "session-toast",
      level: "warn",
      text: "Skill name and description are required.",
      sessionId: msg.sessionId,
    });
    return;
  }

  let serialized;
  try {
    serialized = serialize(msg.finalActions);
  } catch (e) {
    if (e instanceof PromptTooLargeError) {
      postToPanel(port, {
        type: "session-toast",
        level: "error",
        text: `Prompt too long (${e.actualBytes}/${e.maxBytes} bytes). Trim some steps and try again.`,
        sessionId: msg.sessionId,
      });
      return;
    }
    throw e;
  }

  for (const t of msg.finalAllowedTools) {
    if (!ALL_KNOWN_NON_SKILL_TOOL_NAMES.has(t)) {
      postToPanel(port, {
        type: "session-toast",
        level: "error",
        text: `Unknown tool in allowedTools: ${t}`,
        sessionId: msg.sessionId,
      });
      return;
    }
  }

  // P0-B (defense-in-depth)
  const SCHEMA_STRINGS_MAX = 2 * 1024;
  const schemaChars = countAllStringChars(serialized.parameters);
  if (schemaChars > SCHEMA_STRINGS_MAX) {
    postToPanel(port, {
      type: "session-toast",
      level: "error",
      text: `parameters schema strings too long (${schemaChars}/${SCHEMA_STRINGS_MAX} bytes). Reduce the number of distinct redacted fields.`,
      sessionId: msg.sessionId,
    });
    return;
  }

  const finalTools = Array.from(new Set([...msg.finalAllowedTools, "done", "fail"]));

  const skill: SkillDefinition = {
    id: generateUserSkillId(),
    name: msg.skillName.trim(),
    description: msg.skillDescription.trim(),
    promptTemplate: serialized.promptTemplate,
    toolSchema: { parameters: serialized.parameters },
    allowedTools: finalTools,
    enabled: true,
    builtIn: false,
    author: "user",
    createdAt: Date.now(),
  };

  const currentBytes = await getSkillStorageBytes();
  const additional = JSON.stringify(skill).length + `skill_${skill.id}`.length;
  if (currentBytes + additional > SKILL_STORAGE_QUOTA_BYTES) {
    postToPanel(port, {
      type: "session-toast",
      level: "error",
      text: `Skill storage quota exceeded (${currentBytes + additional}/${SKILL_STORAGE_QUOTA_BYTES} bytes). Delete unused skills first.`,
      sessionId: msg.sessionId,
    });
    return;
  }

  await saveSkill(skill);

  recordingState.delete(msg.sessionId);
  postToPanel(port, {
    type: "recording-finished",
    sessionId: msg.sessionId,
    skillId: skill.id,
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

export function handleRecordingTabClosed(port: chrome.runtime.Port, closedTabId: number): void {
  for (const sess of Array.from(recordingState.values())) {
    if (sess.tabId === closedTabId) {
      abortRecordingForSession(port, sess.sessionId, "tab-closed");
    }
  }
}

export async function handleRecordingNavCommitted(
  port: chrome.runtime.Port,
  details: { tabId: number; url: string; frameId: number },
): Promise<void> {
  if (details.frameId !== 0) return;
  const sess = findSessionByTabId(details.tabId);
  if (!sess) return;

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
