// useEngagementPrompt — owns the review/star nudge lifecycle (issue #244).
//
// It watches the active session's `streaming` flag and, on the tick where a
// reply finishes (true → false), re-reads the local `engagement` record and
// decides whether to surface the popup. The nudge is the lowest-priority
// surface: `blocked` (a higher-priority card such as the error / file-access
// card being visible) suppresses it — this turn skips, a later turn re-evaluates.
//
// The counting side (bumpEngagement) lives in sendMessage; this hook only reads
// state and applies the CTA / dismiss transitions.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getEngagement,
  saveEngagement,
  shouldShow,
  markDone,
  applyDismiss,
  type Engagement,
} from "@/lib/engagement";
import {
  CHROME_STORE_REVIEW_URL,
  GITHUB_STAR_URL,
} from "@/lib/engagement-urls";

export interface UseEngagementPromptOptions {
  /** Active session streaming flag. Stream-end (true→false) is the trigger. */
  streaming: boolean;
  /** True when a higher-priority card is showing (error / file-access / panel
   *  request). The nudge yields to it: not shown this turn. */
  blocked: boolean;
}

export interface UseEngagementPromptResult {
  visible: boolean;
  onRate: () => void;
  onStar: () => void;
  onDismiss: () => void;
}

function openTab(url: string): void {
  try {
    void chrome.tabs.create({ url });
  } catch {
    // Non-extension env (tests / SSR) — best-effort no-op.
  }
}

export function useEngagementPrompt(
  opts: UseEngagementPromptOptions,
): UseEngagementPromptResult {
  const { streaming, blocked } = opts;
  const [visibleState, setVisibleState] = useState(false);
  const engagementRef = useRef<Engagement | null>(null);
  const prevStreamingRef = useRef(streaming);

  // Evaluate on the stream-end transition only. prevStreamingRef is updated on
  // every run so a `blocked` change alone can't re-trigger (guard requires the
  // was-streaming → now-idle edge).
  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (!(was && !streaming)) return;
    let cancelled = false;
    void (async () => {
      const e = await getEngagement();
      if (cancelled) return;
      engagementRef.current = e;
      if (!blocked && shouldShow(e, Date.now())) {
        setVisibleState(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [streaming, blocked]);

  const persist = useCallback(async (next: Engagement) => {
    engagementRef.current = next;
    await saveEngagement(next);
  }, []);

  const complete = useCallback(
    (url: string) => {
      setVisibleState(false);
      openTab(url);
      void (async () => {
        const e = engagementRef.current ?? (await getEngagement());
        await persist(markDone(e));
      })();
    },
    [persist],
  );

  const onRate = useCallback(() => complete(CHROME_STORE_REVIEW_URL), [complete]);
  const onStar = useCallback(() => complete(GITHUB_STAR_URL), [complete]);

  const onDismiss = useCallback(() => {
    setVisibleState(false);
    void (async () => {
      const e = engagementRef.current ?? (await getEngagement());
      await persist(applyDismiss(e, Date.now()));
    })();
  }, [persist]);

  return {
    // Yield to any higher-priority card even after we decided to show.
    visible: visibleState && !blocked,
    onRate,
    onStar,
    onDismiss,
  };
}
