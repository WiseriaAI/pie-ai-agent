/**
 * Issue #27 — post-action page-settle wait.
 *
 * The agent loop's per-iteration observation pulls URL from
 * `chrome.tabs.get` and DOM elements from `chrome.scripting.executeScript`.
 * These two APIs see different moments of the navigation lifecycle: tab
 * metadata updates at navigation commit / `history.pushState`, while the
 * scripting target's DOM may still be the outgoing document or be
 * mid-swap. After a click that triggers a real navigation, a Turbo /
 * pushState route change, or an async DOM update (AJAX content load),
 * the next iteration would race the page state and report stale elements
 * back to the model — which then re-clicked the same submit button two
 * or three times before getting through.
 *
 * The fix lives at the action level: clicks and key dispatches that may
 * mutate the page wait for any consequences to settle before resolving
 * their tool result. The next iteration then snapshots a stable page.
 *
 * Two activity signals are tracked in parallel:
 *
 *   1. **SW-side `chrome.webNavigation` events** — `onCommitted` for real
 *      cross-document navigations; `onHistoryStateUpdated` for SPA
 *      pushState route changes (Turbo, React Router, Vue Router…). These
 *      survive page tear-down because they fire in the SW, not the page.
 *
 *   2. **Page-side `window.__pieMutAt`** — fed by a global MutationObserver
 *      installed by `installMutationTracker` before the action runs.
 *      Polled after the action via `readMutationTimestamp`. Catches async
 *      DOM updates that don't trigger any navigation event — clicking
 *      "like" on a tweet, opening an AJAX-loaded sub-form, infinite-scroll
 *      content arriving, etc. Synchronous mutations (dropdown / accordion /
 *      modal toggle) bump it inside the click handler so the post-click
 *      quiet wait still lets them settle for one quiet window.
 *
 * Cap behavior: the wait exits when either (a) the time since the last
 * observed activity reaches `quietMs`, or (b) the total elapsed time
 * since the action returned reaches `maxMs`. The cap defends against
 * pages with continuous mutations (live dashboards, animation-heavy
 * landing pages) that would otherwise wedge the loop.
 */

import type { ActionResult } from "../dom-actions/types";

/**
 * Self-contained injected helper. Idempotent install of a global
 * MutationObserver on document.body that updates `window.__pieMutAt`
 * to `Date.now()` on every childList / subtree mutation. Re-calling
 * the function on a tab where the observer is already installed bumps
 * the baseline timestamp without leaking a second observer.
 *
 * MUST be self-contained for `chrome.scripting.executeScript`: no
 * imports, no closures, no outer-scope references at runtime.
 */
function installMutationTracker(): void {
  type W = { __pieMutAt?: number; __pieMutObs?: MutationObserver };
  const w = window as unknown as W;
  if (w.__pieMutObs) {
    // Idempotent re-call: just bump the baseline so the post-action
    // quiet check measures from "now" rather than the install time of
    // a prior action.
    w.__pieMutAt = Date.now();
    return;
  }
  const installedAt = Date.now();
  w.__pieMutAt = installedAt;
  const obs = new MutationObserver(() => {
    (window as unknown as W).__pieMutAt = Date.now();
  });
  // `document.body` is null very early in load (before <body> parsed);
  // fall back to `document` so we still register top-level changes.
  obs.observe(document.body ?? document, {
    childList: true,
    subtree: true,
  });
  w.__pieMutObs = obs;
}

function readMutationTimestamp(): number {
  return (window as unknown as { __pieMutAt?: number }).__pieMutAt ?? 0;
}

/**
 * #251 — build the observation suffix appended when an action opened one or
 * more new tabs (target=_blank / window.open fanout). Only browser-derived
 * tab ids (numbers) and origins parsed via `new URL().origin` make it into
 * the text — NEVER the page-controlled tab title, which is an injection
 * surface. The suffix points the model at `switch_to_new_tab`, the
 * recovery tool that adopts + focuses a tab the session spawned.
 */
function formatNewTabNotice(
  ids: number[],
  origins: Map<number, string>,
): string {
  const label = (id: number) => {
    const origin = origins.get(id);
    return origin ? `${id}, ${origin}` : `${id}`;
  };
  if (ids.length === 1) {
    return `This action opened a new tab (id ${label(ids[0])}). If the task continues there, call switch_to_new_tab to adopt and focus it.`;
  }
  const list = ids.map(label).join("; ");
  return `This action opened ${ids.length} new tabs (${list}). If the task continues in one of them, call switch_to_new_tab to adopt and focus it.`;
}

export interface ActionSettleOptions {
  /**
   * Quiet window required to declare the page settled. After the action
   * returns, the wait loop continues until `now - lastActivityAt >= quietMs`.
   * Default 500ms — empirically large enough to bridge a typical Turbo
   * fetch round-trip on a normal connection without making non-mutating
   * clicks (dropdown open, input focus) feel sluggish. Slow networks may
   * still race; the trade-off is documented in #27.
   */
  quietMs?: number;
  /**
   * Hard cap on total wait, ms. Default 3000. Prevents wedging on pages
   * with continuous DOM mutations (live charts, animated banners) where
   * the quiet condition would never be met.
   */
  maxMs?: number;
  /**
   * Polling interval for the page-side mutation timestamp + the quiet
   * check, ms. Default 100. Lower = sooner exit on settle, more
   * executeScript IPC calls; 100ms is a reasonable balance.
   */
  pollMs?: number;
}

/**
 * Run an action that may mutate the page, then wait for any consequences
 * to settle before returning the action's result. See module-level JSDoc
 * for the design rationale and signal taxonomy.
 *
 * `performAction` is invoked AFTER the mutation tracker is installed and
 * the webNavigation listeners are attached, so synchronous DOM mutations
 * inside the action's click handler are captured. Failures from
 * `performAction` short-circuit the wait — the result is returned
 * immediately without any settle delay.
 */
export async function withActionSettle<T extends ActionResult>(
  tabId: number,
  performAction: () => Promise<T>,
  options: ActionSettleOptions = {},
): Promise<T> {
  const { quietMs = 500, maxMs = 3000, pollMs = 100 } = options;

  // Install the mutation tracker BEFORE the action so a synchronous DOM
  // mutation during the action's click handler is captured. Best-effort
  // — injection can fail on restricted pages, mid-navigation tear-down,
  // or detached tabs; in those cases we fall back to webNavigation-only
  // observation, which still covers cross-doc nav and SPA pushState.
  let trackerInstalled = false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: installMutationTracker,
    });
    trackerInstalled = true;
  } catch {
    trackerInstalled = false;
  }

  let lastSignalAt = 0;
  const onNavEvent = (details: { tabId: number; frameId: number }) => {
    // frameId 0 = top frame; sub-frame nav doesn't change the agent's
    // observation target so we ignore it.
    if (details.tabId !== tabId || details.frameId !== 0) return;
    lastSignalAt = Date.now();
  };
  chrome.webNavigation.onCommitted.addListener(onNavEvent);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onNavEvent);

  // #251 — detect fanout: a click / keypress that opens a new tab via
  // target=_blank or window.open. The settle signals above are all scoped to
  // the acting tab, so the model would otherwise never learn a new tab exists
  // and stall on the original page. Collect tabs whose `openerTabId` is the
  // acting tab; on a successful action their ids (+ parsed origins, never the
  // page-controlled title) are appended to the observation.
  const newTabIds: number[] = [];
  const newTabOrigins = new Map<number, string>();
  const onTabCreated = (tab: chrome.tabs.Tab) => {
    if (tab.id === undefined || tab.openerTabId !== tabId) return;
    if (newTabIds.includes(tab.id)) return;
    newTabIds.push(tab.id);
    // At onCreated time the tab may still be about:blank with the real
    // destination in `pendingUrl`; prefer whichever parses to a concrete
    // origin. Unparseable / opaque ("null") origins are simply omitted.
    const rawUrl = tab.pendingUrl || tab.url || "";
    if (rawUrl) {
      try {
        const origin = new URL(rawUrl).origin;
        if (origin && origin !== "null") newTabOrigins.set(tab.id, origin);
      } catch {
        // unparseable URL — id-only notice
      }
    }
  };
  chrome.tabs.onCreated.addListener(onTabCreated);

  try {
    const result = await performAction();
    if (!result.success) return result;

    const performedAt = Date.now();

    // Settle loop. `lastActivityAt` is the maximum of three timestamps:
    //   - performedAt: floor so we always wait at least quietMs after the
    //     action returns (lets sync DOM mutations during the click
    //     handler clear the quiet check).
    //   - lastSignalAt: bumped by webNavigation events.
    //   - pageMutAt: bumped by the page-side MutationObserver via the
    //     latest poll.
    while (true) {
      await new Promise<void>((r) => setTimeout(r, pollMs));
      const now = Date.now();

      let pageMutAt = 0;
      if (trackerInstalled) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: readMutationTimestamp,
          });
          pageMutAt = (results[0]?.result as number) ?? 0;
        } catch {
          // Cross-doc tear-down in progress — the script context is
          // gone. Treat that itself as a signal (extend the wait by one
          // quiet window) and try to re-install the tracker on the new
          // doc once it's available. Re-install is fire-and-forget so
          // the loop body stays prompt; if the new doc rejects it
          // (chrome:// landing page, etc.) we continue with
          // webNavigation-only observation.
          trackerInstalled = false;
          lastSignalAt = now;
          chrome.scripting
            .executeScript({
              target: { tabId },
              func: installMutationTracker,
            })
            .then(() => {
              trackerInstalled = true;
            })
            .catch(() => {
              // best-effort; the new doc may be inaccessible
            });
        }
      }

      const lastActivityAt = Math.max(lastSignalAt, pageMutAt, performedAt);
      const sinceLastActivity = now - lastActivityAt;
      const elapsed = now - performedAt;

      if (sinceLastActivity >= quietMs) break;
      if (elapsed >= maxMs) break;
    }

    if (newTabIds.length > 0) {
      const notice = formatNewTabNotice(newTabIds, newTabOrigins);
      result.observation = result.observation
        ? `${result.observation} ${notice}`
        : notice;
    }

    return result;
  } finally {
    chrome.webNavigation.onCommitted.removeListener(onNavEvent);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onNavEvent);
    chrome.tabs.onCreated.removeListener(onTabCreated);
  }
}
