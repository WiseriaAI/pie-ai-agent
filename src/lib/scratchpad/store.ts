// src/lib/scratchpad/store.ts
//
// IndexedDB persistence for scratchpads. The `pie` db `scratchpads` store
// holds one record per session (keyPath "id" === sessionId). Read-miss
// returns a fresh empty scratchpad so callers never deal with undefined.

import { tx, STORES } from "../idb/db";
import { publishChange } from "../store-bus";
import { emptyScratchpad, type Scratchpad } from "./types";

export async function readScratchpad(sessionId: string): Promise<Scratchpad> {
  const rec = await tx<Scratchpad | undefined>(
    STORES.scratchpads,
    "readonly",
    (s) => s.get(sessionId),
  );
  return rec ?? emptyScratchpad(sessionId);
}

export async function writeScratchpad(pad: Scratchpad): Promise<void> {
  const stamped: Scratchpad = { ...pad, updatedAt: Date.now() };
  await tx(STORES.scratchpads, "readwrite", (s) => s.put(stamped));
  publishChange("scratchpads", "put", pad.id);
}

export async function deleteScratchpad(sessionId: string): Promise<void> {
  await tx(STORES.scratchpads, "readwrite", (s) => s.delete(sessionId));
  publishChange("scratchpads", "remove", sessionId);
}
