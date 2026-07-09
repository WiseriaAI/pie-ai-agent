/**
 * Issue #261 follow-up — per-frame fan-out replacement for
 * `executeScript({ allFrames: true })`.
 *
 * A single allFrames call binds every frame to one promise: Chrome only
 * resolves it once EVERY frame has run the script. A frame whose navigation
 * was deliberately interrupted (micro-app / wujie iframe-sandbox frames,
 * dead ad iframes) can wedge that promise forever — and on some Chrome
 * builds (observed on branded 149.0.7827.201) even `injectImmediately: true`
 * does not unblock injection into such a frame, while frame-targeted
 * injection into healthy frames keeps working.
 *
 * So: enumerate frames via webNavigation, inject each frame independently in
 * parallel with `injectImmediately: true`, and give each frame its own
 * timeout budget. A frame that never responds costs its own budget and is
 * reported in `timedOutFrameIds` (callers surface it as unreachable) instead
 * of hanging the whole tool call.
 */

/** Top frame carries the page's primary content — give it a generous budget. */
const TOP_FRAME_TIMEOUT_MS = 10_000;
/**
 * Sub-frames get a tighter budget: the probe itself is sub-second even on
 * huge documents; a frame that stays silent this long is treated as
 * unreachable rather than allowed to stall the read.
 */
const SUB_FRAME_TIMEOUT_MS = 2_000;

export interface AllFramesInjectionOutcome<T> {
  /** webNavigation frame tree snapshot taken before injection. */
  frames: chrome.webNavigation.GetAllFrameResultDetails[];
  /** One entry per enumerated frame; `result` undefined = injection failed or timed out. */
  results: { frameId: number; result: T | undefined }[];
  /** Frames whose injection never settled within their budget (zombie frames). */
  timedOutFrameIds: Set<number>;
}

export interface AllFramesInjectionOptions {
  topFrameTimeoutMs?: number;
  subFrameTimeoutMs?: number;
}

const TIMEOUT = Symbol("inject-timeout");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function executeScriptAllFrames<TResult>(
  tabId: number,
  // Mirrors chrome.scripting's loose func/args contract; call sites cast the
  // typed injected function in, exactly as they did with the allFrames call.
  func: (...args: never[]) => unknown,
  args?: unknown[],
  options: AllFramesInjectionOptions = {},
): Promise<AllFramesInjectionOutcome<TResult>> {
  const {
    topFrameTimeoutMs = TOP_FRAME_TIMEOUT_MS,
    subFrameTimeoutMs = SUB_FRAME_TIMEOUT_MS,
  } = options;

  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames) throw new Error("Tab unavailable");

  const timedOutFrameIds = new Set<number>();
  const results = await Promise.all(
    frames.map(async (f) => {
      const budgetMs = f.frameId === 0 ? topFrameTimeoutMs : subFrameTimeoutMs;
      try {
        const injected = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId, frameIds: [f.frameId] },
            func: func as () => unknown,
            ...(args !== undefined ? { args } : {}),
            // Read current DOM state — never wait for document_idle (a frame
            // with an interrupted navigation never reaches idle).
            injectImmediately: true,
          }),
          budgetMs,
        );
        if (injected === TIMEOUT) {
          timedOutFrameIds.add(f.frameId);
          return { frameId: f.frameId, result: undefined };
        }
        return { frameId: f.frameId, result: injected[0]?.result as TResult | undefined };
      } catch {
        // Frame torn down mid-flight, CSP-blocked, etc. — unreachable, not a
        // timeout; downstream classification keys off frame metadata.
        return { frameId: f.frameId, result: undefined };
      }
    }),
  );

  return { frames, results, timedOutFrameIds };
}
