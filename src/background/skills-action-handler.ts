// src/background/skills-action-handler.ts
//
// Task 8 — SW-side handler for the panel skills RPC channel (list/read-file/
// write/delete). The panel cannot connectNative (SW-only), so it routes every
// skills action through here to whichever SkillSource is currently active
// (IDB or daemon disk — mode decided by getActiveSkillSource()).
//
// list() returns the FULL merged list with NO enabled/disabled filtering:
// SkillsList (settings UI, Task 9) needs to display disabled entries too.
// Chat's slash popover filters client-side (filterEnabled, reading enabled
// markers straight from IDB config) — this handler has zero enabled-filtering
// logic, on purpose.
//
// Every branch: await bridgeSettled() (so a cold-boot handshake race can't
// read a stale idb-vs-disk mode) → getActiveSkillSource() → execute. Never
// throws across the sendMessage boundary — a thrown source-method error or a
// malformed payload both become { ok:false, error }.

import { getActiveSkillSource } from "./skill-source";
import { bridgeSettled } from "./local-bridge";
import type { SkillWriteFile } from "@/lib/skills/source";
import type {
  SkillsActionMessage,
  SkillsListResponse,
  SkillsReadFileResponse,
  SkillsWriteResponse,
  SkillsDeleteResponse,
} from "@/lib/skills/panel-actions";

export type SkillsActionResponse =
  | SkillsListResponse
  | SkillsReadFileResponse
  | SkillsWriteResponse
  | SkillsDeleteResponse;

export async function handleSkillsAction(m: SkillsActionMessage): Promise<SkillsActionResponse> {
  try {
    await bridgeSettled();
    const source = getActiveSkillSource();
    switch (m.action) {
      case "list": {
        const skills = await source.list();
        return { ok: true, skills };
      }
      case "read-file": {
        const p = m.payload as { id?: unknown; path?: unknown } | undefined;
        if (typeof p?.id !== "string" || typeof p?.path !== "string") {
          return { ok: false, error: "read-file requires { id, path }" };
        }
        const content = await source.readFile(p.id, p.path);
        return { ok: true, content };
      }
      case "write": {
        const p = m.payload as { id?: unknown; files?: unknown } | undefined;
        if (typeof p?.id !== "string" || !Array.isArray(p.files)) {
          return { ok: false, error: "write requires { id, files[] }" };
        }
        await source.write(p.id, p.files as SkillWriteFile[]);
        return { ok: true };
      }
      case "delete": {
        const p = m.payload as { id?: unknown } | undefined;
        if (typeof p?.id !== "string") {
          return { ok: false, error: "delete requires { id }" };
        }
        const deleted = await source.delete(p.id);
        return { ok: true, deleted };
      }
      default:
        return { ok: false, error: `unknown skills action: ${String((m as { action: unknown }).action)}` };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
