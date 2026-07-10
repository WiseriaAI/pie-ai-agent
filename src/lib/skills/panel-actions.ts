// src/lib/skills/panel-actions.ts
//
// Task 8 — panel→SW RPC channel for skills. The side panel cannot reach the
// local daemon directly (connectNative is SW-only), so panel consumers (Chat
// slash popover, SkillsList settings UI — Task 9) read/write skills through
// this channel, which routes to the SW's active SkillSource (IDB or daemon
// disk, decided by getActiveSkillSource()). Mirrors
// src/lib/schedules/panel-actions.ts's message-const + typed-actions + thin
// swPort.request wrapper shape.

import { swPort } from "@/lib/sw-connection/manager";
import type { SkillEntry, SkillWriteFile } from "./source";

export const SKILLS_ACTION_MESSAGE = "skills-action" as const;

export interface SkillsActionMessage {
  type: typeof SKILLS_ACTION_MESSAGE;
  action: "list" | "read-file" | "write" | "delete";
  payload?: unknown;
}

export type SkillsListResponse = { ok: true; skills: SkillEntry[] } | { ok: false; error: string };
export type SkillsReadFileResponse = { ok: true; content: string | null } | { ok: false; error: string };
export type SkillsWriteResponse = { ok: true } | { ok: false; error: string };
export type SkillsDeleteResponse = { ok: true; deleted: boolean } | { ok: false; error: string };

/**
 * Full merged skill list (builtin + user, from whichever backend is active) —
 * NOT filtered by enabled/disabled. SkillsList needs disabled entries visible;
 * Chat's slash popover applies filterEnabled itself client-side.
 */
export function listSkillEntries(): Promise<SkillsListResponse> {
  return swPort.request<SkillsListResponse>({ type: SKILLS_ACTION_MESSAGE, action: "list" });
}

export function readSkillFileRpc(id: string, path: string): Promise<SkillsReadFileResponse> {
  return swPort.request<SkillsReadFileResponse>({
    type: SKILLS_ACTION_MESSAGE,
    action: "read-file",
    payload: { id, path },
  });
}

export function writeSkillRpc(id: string, files: SkillWriteFile[]): Promise<SkillsWriteResponse> {
  return swPort.request<SkillsWriteResponse>({
    type: SKILLS_ACTION_MESSAGE,
    action: "write",
    payload: { id, files },
  });
}

export function deleteSkillRpc(id: string): Promise<SkillsDeleteResponse> {
  return swPort.request<SkillsDeleteResponse>({
    type: SKILLS_ACTION_MESSAGE,
    action: "delete",
    payload: { id },
  });
}
