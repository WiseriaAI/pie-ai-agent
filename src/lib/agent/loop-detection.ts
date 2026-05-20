/**
 * Issue #61(a) — deterministic, zero-LLM-cost loop detection for the ReAct
 * agent loop. Pure module (no IO, no globals) so it can be unit tested in
 * isolation. The loop maintains a small ring buffer of recent step
 * signatures and asks detectLoop() each round whether the agent is spinning
 * in place. This is fail-fast self-rescue, NOT a replacement for MAX_STEPS.
 */

/** One tool call reduced to what the detector cares about. */
export interface ToolCallLike {
  name: string;
  args: unknown;
}

/** A recorded step in the ring buffer. */
export interface StepSignature {
  /** Stable fingerprint of every tool call in the step (name + args). */
  sig: string;
  /** True when EVERY tool_result in the step was an error — drives the
   *  B-detector ("repeat + error"). */
  allErrored: boolean;
}

export type LoopVerdict =
  /** No loop detected. */
  | { kind: "none" }
  /** A — the same signature is about to run for the Nth consecutive time. */
  | { kind: "exact-repeat"; count: number }
  /** B — the same signature repeated and the prior occurrences all errored. */
  | { kind: "repeat-error"; count: number }
  /** C — the agent is cycling between the same `period` distinct actions
   *  (e.g. a→b→a→b), with no progress. `cycles` is at least this many full
   *  cycles (lower bound, == oscillationMinCycles); the actual count may be
   *  higher — the detector stops counting once the threshold is met. */
  | { kind: "oscillation"; period: number; cycles: number };

export interface DetectLoopOptions {
  /** Consecutive identical steps (incl. the current one) that trip A. Default 3. */
  exactRepeatThreshold?: number;
  /** Consecutive identical errored steps (incl. current) that trip B. Default 2. */
  repeatErrorThreshold?: number;
  /** Largest cycle period to scan for (C). Default 3. Period 1 == exact-repeat.
   *  Tradeoff: periods larger than this go undetected — raise it if longer
   *  cycles are suspected, at the cost of a larger ring buffer + more CPU. */
  oscillationMaxPeriod?: number;
  /** Minimum number of full cycles required to call it an oscillation (C).
   *  Default 2 (i.e. the block must appear at least twice: a→b→a→b). */
  oscillationMinCycles?: number;
}

/**
 * Deterministic JSON with sorted object keys, so {a:1,b:2} and {b:2,a:1}
 * fingerprint identically. null / undefined / functions collapse to "null".
 *
 * We deliberately do NOT guard against circular refs or NaN/Infinity: the only
 * caller fingerprints tool-call `args` that originate from `JSON.parse(...)`,
 * and JSON output is acyclic and cannot represent NaN/Infinity. Adding a
 * WeakSet cycle guard would be defending against an input that cannot occur.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** Reduce all tool calls in one step to a single stable signature string. */
export function stepSignature(calls: ReadonlyArray<ToolCallLike>): string {
  return calls.map((c) => `${c.name}:${stableStringify(c.args)}`).join("|");
}

/**
 * #64(C) — detect a period-p oscillation in the signature sequence
 * `seq` (oldest→newest, current step last). Returns the smallest qualifying
 * period in [2, maxPeriod] whose last `minCycles` blocks are all identical,
 * or null. A block whose entries are all identical is NOT an oscillation
 * (that is exact-repeat / period 1, handled separately).
 */
function detectOscillation(
  seq: ReadonlyArray<string>,
  maxPeriod: number,
  minCycles: number,
): { period: number; cycles: number } | null {
  for (let p = 2; p <= maxPeriod; p++) {
    const need = p * minCycles;
    if (seq.length < need) continue;
    const tail = seq.slice(seq.length - need);
    const pattern = tail.slice(tail.length - p); // last p entries define the block
    // The block must contain at least two distinct sigs, else it's a pure repeat.
    if (new Set(pattern).size < 2) continue;
    let matches = true;
    for (let i = 0; i < need; i++) {
      if (tail[i] !== pattern[i % p]) {
        matches = false;
        break;
      }
    }
    // Reports the confirmed lower bound (minCycles), not the exact cycle count.
    if (matches) return { period: p, cycles: minCycles };
  }
  return null;
}

/**
 * Decide whether the current step (identified by `currentSig`) continues a
 * run of identical recent steps long enough to count as a loop.
 *
 * `recent` is the ring buffer of PAST executed steps (oldest→newest);
 * `currentSig` is the step about to execute. We walk backwards over `recent`
 * counting trailing entries equal to `currentSig`, then add 1 for the current
 * step.
 *
 *   - B (repeat-error): the trailing run is non-empty, all errored, and the
 *     effective count (run + current) ≥ repeatErrorThreshold. Checked first.
 *   - A (exact-repeat): effective count ≥ exactRepeatThreshold.
 *   - C (oscillation): the sequence cycles through a repeating pattern of
 *     period ≥ 2 for at least oscillationMinCycles full cycles.
 *
 * Timing note: detectLoop runs BEFORE the current step executes, so only the
 * PAST run's error bits are known — the current step's error status is
 * intentionally not considered. This means B can fire on a step that might
 * still have succeeded; that is the intended fail-fast behavior.
 */
export function detectLoop(
  recent: ReadonlyArray<StepSignature>,
  currentSig: string,
  options: DetectLoopOptions = {},
): LoopVerdict {
  const exactRepeatThreshold = options.exactRepeatThreshold ?? 3;
  const repeatErrorThreshold = options.repeatErrorThreshold ?? 2;
  const oscillationMaxPeriod = options.oscillationMaxPeriod ?? 3;
  const oscillationMinCycles = options.oscillationMinCycles ?? 2;

  let run = 0;
  let runAllErrored = true;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].sig !== currentSig) break;
    run++;
    if (!recent[i].allErrored) runAllErrored = false;
  }
  const effective = run + 1; // include the current step

  if (run > 0 && runAllErrored && effective >= repeatErrorThreshold) {
    return { kind: "repeat-error", count: effective };
  }
  if (effective >= exactRepeatThreshold) {
    return { kind: "exact-repeat", count: effective };
  }

  // C — oscillation (period ≥ 2). Checked after the period-1 detectors so a
  // pure repeat is always reported as exact-repeat, not oscillation.
  const seq = [...recent.map((r) => r.sig), currentSig];
  const osc = detectOscillation(seq, oscillationMaxPeriod, oscillationMinCycles);
  if (osc) {
    return { kind: "oscillation", period: osc.period, cycles: osc.cycles };
  }

  return { kind: "none" };
}

/**
 * Push `entry` onto the ring buffer, evicting the oldest when over `cap`.
 * Mutates and returns the same array (loop-scoped, single owner).
 */
export function recordStep(
  buffer: StepSignature[],
  entry: StepSignature,
  cap: number,
): StepSignature[] {
  buffer.push(entry);
  while (buffer.length > cap) buffer.shift();
  // Returns the same (mutated) array for call-site convenience.
  return buffer;
}
