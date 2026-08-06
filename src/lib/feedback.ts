// Feedback helpers. Pure functions over injected data so they unit-test
// without chrome/DOM. Two surfaces consume these: the Settings Feedback
// section (GitHub / mailto links + free-text form) and the per-message
// "Report problem" drawer in Chat (`buildTranscript`).

import type { DisplayMessage } from "@/types/messages";

export const GITHUB_REPO = "WiseriaAI/pie-ai-agent";

export const FEEDBACK_EMAIL = "feedback@pie.chat";

export interface FeedbackEnv {
  /** Extension version, e.g. chrome.runtime.getManifest().version */
  version: string;
  /** navigator.userAgent */
  userAgent: string;
  /** "provider · model" of the active config, or a placeholder when none */
  providerModel: string;
  /** Resolved UI locale, e.g. "en" | "zh-CN" */
  locale: string;
}

export function buildEnvBlock(env: FeedbackEnv): string {
  return [
    "## Environment",
    `- version: ${env.version}`,
    `- browser: ${env.userAgent}`,
    `- active config: ${env.providerModel}`,
    `- locale: ${env.locale}`,
  ].join("\n");
}

function issueBody(env: FeedbackEnv): string {
  return [
    "## What happened?",
    "",
    "(describe the problem here)",
    "",
    buildEnvBlock(env),
  ].join("\n");
}

export function buildGithubNewIssueUrl(env: FeedbackEnv): string {
  const body = encodeURIComponent(issueBody(env));
  return `https://github.com/${GITHUB_REPO}/issues/new?labels=user-report&body=${body}`;
}

export function buildFeedbackMailto(env: FeedbackEnv): string {
  const subject = encodeURIComponent("Pie Feedback");
  const body = encodeURIComponent(issueBody(env));
  return `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
}

// ── Chat transcript for "Report problem" ────────────────────────────────────
//
// Source is the panel's live `DisplayMessage[]`, NOT storage: `agent-step`
// rows (tool + args + observation — the whole point of a debug report) are
// React-state-only and never persisted, and `SessionAgentState.agentMessages`
// is tombstoned the moment a task ends. The live array is the only place the
// tool trace exists once the task is done.
//
// PRIVACY: observations carry raw page content the agent read. This transcript
// leaves the device, so the drawer must say so before the user sends it.

/** Head/tail chars kept per long field. Errors sit at the tail, so keep both. */
const CLIP_CHARS = 2000;
/** Byte budget for the whole transcript. Backend bodyLimit is 256KB and
 *  `message` + `env` + JSON escaping ride along in the same request. */
export const MAX_TRANSCRIPT_BYTES = 150_000;

function clip(s: string, chars = CLIP_CHARS): string {
  if (s.length <= chars * 2) return s;
  const dropped = s.length - chars * 2;
  return `${s.slice(0, chars)}\n…[${dropped} chars truncated]…\n${s.slice(-chars)}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Keep the TAIL when over budget — the failure the user is reporting is at
 *  the end of the conversation, so dropping the head loses the least. */
function capTailBytes(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  const note = `…[${bytes.length - maxBytes} bytes of earlier history dropped]…\n\n`;
  // Reserve room for the note so the result still fits the budget. Slicing at
  // a byte offset can cut a multi-byte char → decode non-fatally and strip the
  // U+FFFD that leaves at the front.
  const room = Math.max(0, maxBytes - new TextEncoder().encode(note).length);
  const tail = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(bytes.length - room))
    .replace(/^�+/u, "");
  return note + tail;
}

/**
 * Flatten the visible conversation into a plain-text debug transcript.
 *
 * `markIndex` is the index of the message whose "Report problem" button was
 * clicked — the transcript stays full (context before the failure is what
 * makes it diagnosable) and just marks the spot the user pointed at.
 *
 * Image bytes are never inlined: a base64 JPEG would blow the whole budget on
 * one screenshot, so they degrade to a `[image WxH]` marker.
 */
export function buildTranscript(
  messages: readonly DisplayMessage[],
  markIndex?: number,
): string {
  const lines: string[] = [];
  messages.forEach((m, i) => {
    if (i === markIndex) lines.push(">>> user reported a problem on the message below <<<");
    switch (m.role) {
      case "user": {
        const extras = [
          m.attachments?.length ? `${m.attachments.length} attachment(s)` : "",
          m.quotes?.length ? `${m.quotes.length} quote(s)` : "",
          m.fileAttachments?.length ? `${m.fileAttachments.length} file(s)` : "",
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(`[user]${extras ? ` (${extras})` : ""}\n${clip(m.content)}`);
        break;
      }
      case "assistant":
        if (m.thinking) lines.push(`[assistant thinking]\n${clip(m.thinking)}`);
        lines.push(`[assistant]\n${clip(m.content)}`);
        break;
      case "agent-step": {
        const img = m.image ? ` [image ${m.image.width}x${m.image.height}]` : "";
        const head = `[step ${m.stepIndex}] ${m.tool}(${clip(safeJson(m.args), 500)}) → ${m.status}${img}`;
        lines.push(m.observation ? `${head}\n${clip(m.observation)}` : head);
        break;
      }
      case "agent-summary":
        lines.push(
          `[summary ${m.success ? "ok" : "fail"} steps=${m.stepCount}]\n${clip(m.summary)}`,
        );
        break;
      case "session-confirm":
        lines.push(`[confirm ${m.kind}] ${m.resolved ?? "pending"}`);
        break;
      case "file-output":
        lines.push(`[file] ${m.filename} (${m.mime}, ${m.size} bytes)`);
        break;
    }
  });
  return capTailBytes(lines.join("\n\n"), MAX_TRANSCRIPT_BYTES);
}
