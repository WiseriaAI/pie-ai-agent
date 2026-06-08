// src/lib/scratchpad/overview.ts
//
// Builds the bounded <scratchpad_overview> block injected into every
// observation turn. This block rides the trailing user message, which the
// sliding-window / compaction / token-budget mechanisms never trim — so the
// LLM always sees what it has stored and where it is, even after compaction
// summarizes the react steps that did the writing.

import type { Scratchpad } from "./types";
import { escapeUntrustedWrappers } from "../agent/untrusted-wrappers";

const PREVIEW_PER_COLLECTION = 3;
const PREVIEW_MAX_CHARS = 300; // per record, before escaping

function previewRecord(rec: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(rec);
  } catch {
    s = String(rec);
  }
  if (s.length > PREVIEW_MAX_CHARS) s = s.slice(0, PREVIEW_MAX_CHARS) + "…";
  // Page-derived values — neutralize any wrapper-tag literals so the data
  // cannot break out of <untrusted_scratchpad_preview>.
  return escapeUntrustedWrappers(s);
}

export function buildOverview(pad: Scratchpad): string {
  const collectionNames = Object.keys(pad.collections);
  if (collectionNames.length === 0 && !pad.notes) return "";

  const lines: string[] = ["<scratchpad_overview>"];

  if (collectionNames.length > 0) {
    lines.push("collections:");
    for (const name of collectionNames) {
      const col = pad.collections[name];
      const dedupe = col.dedupeKey ? ` (dedupeKey=${col.dedupeKey})` : "";
      lines.push(`  - ${name}: ${col.records.length}${dedupe}`);
      const preview = col.records.slice(0, PREVIEW_PER_COLLECTION);
      for (const rec of preview) {
        lines.push(
          `      <untrusted_scratchpad_preview>${previewRecord(rec)}</untrusted_scratchpad_preview>`,
        );
      }
    }
  }

  if (pad.notes) {
    lines.push("notes:");
    lines.push(pad.notes);
  }

  lines.push("</scratchpad_overview>");
  return lines.join("\n");
}
