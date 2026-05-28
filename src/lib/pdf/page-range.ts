/**
 * Parse a 1-indexed page-range spec like "1", "1-3", "1,3,5", "1-3,7".
 *
 * Rules:
 *  - Empty / undefined spec → [1] (first page).
 *  - Out-of-range page numbers are silently dropped (no throw). The LLM
 *    is already given total_pages on its first read, so spurious page
 *    requests are a low-stakes UX issue rather than a tool error.
 *  - Reverse range like "3-1" → [] (do NOT swap silently — looks like
 *    a typo the agent should learn to fix, not something to paper over).
 *  - total=0 collapses everything to [].
 */
export function parsePageRange(
  spec: string | undefined,
  totalPages: number,
): number[] {
  if (totalPages <= 0) return [];
  if (spec === undefined || spec.trim() === "") return [1];

  const pages = new Set<number>();
  const parts = spec.split(",").map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    if (part.includes("-")) {
      const [aStr, bStr] = part.split("-").map((s) => s.trim());
      const a = Number(aStr);
      const b = Number(bStr);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      if (a > b) continue; // reverse range: don't auto-swap
      for (let p = a; p <= b; p++) {
        if (p >= 1 && p <= totalPages) pages.add(p);
      }
    } else {
      const p = Number(part);
      if (Number.isInteger(p) && p >= 1 && p <= totalPages) pages.add(p);
    }
  }

  return [...pages].sort((x, y) => x - y);
}
