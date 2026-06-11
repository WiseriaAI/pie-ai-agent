import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/model-router";
import type { ImageAttachment } from "@/lib/images";
import type { FileAttachment } from "@/lib/files/types";
import { useT } from "@/lib/i18n";
import type {
  DisplayMessage,
  PortMessageToPanel,
  PortMessageToWorker,
  Quote,
} from "@/types";
import {
  createSession,
  getSessionAgent,
  getSessionMeta,
  listSessionIndex,
  setSessionMeta,
  updateLastAccessed,
} from "@/lib/sessions/storage";
import { hardDeleteSession } from "@/lib/sessions/lifecycle";
import { useStoreChange } from "@/sidepanel/hooks/useStoreChange";
import type { SessionAgentState, SessionMeta, SessionStatus } from "@/lib/sessions/types";
import { deriveTitleFromMessages } from "@/lib/sessions/title";
import { togglePinTabUserMode } from "@/lib/sessions/pin-state";
import {
  EMPTY_SLOT,
  deriveActiveView,
  withSlot,
  type SessionRuntimeSlot,
} from "./runtime-map";
import { createPortHandlers } from "./port-handlers";
import { isFilePdfUrl } from "@/lib/pdf/detect";
import {
  type DownloadResult,
  registerDownload,
  resolveDownload,
} from "./download-pending";

/**
 * useSession — single-source-of-truth for the active session's messages,
 * port connection, and streaming state. Lives at App level so the port
 * and onMessage listener survive across Chat ↔ Settings sub-view swaps;
 * if Chat owned them, switching to Settings would unmount Chat, detach
 * the listener, and silently drop SW-pushed chunks.
 *
 * **M1 single-session mode** — the hook auto-creates one session if the
 * index is empty and otherwise picks the most-recently-accessed entry.
 * M2-U1 will introduce an explicit `activeSessionId` parameter and
 * multi-session UI; until then `sessionId` is implicit.
 *
 * **M1-U4 — mount-immediate connection.** The port is opened on hook
 * mount, not on first sendMessage. Reasons:
 *   - On mount, opens port immediately + sends `panel-mounted` so the SW can
 *     re-emit any live session state (e.g. pending session confirm requests).
 *     the panel re-renders the card without the user having to type.
 *   - the listener is attached once at mount and survives every
 *     subsequent stream (no re-attach per sendMessage), eliminating an
 *     entire class of "listener attached after first chunk" race.
 *
 * Persistence boundaries (avoid mid-stream storage churn):
 *   - chat-done       → assistant message + persist
 *   - chat-error      → record error + persist
 *   - agent-done-task → final summary + persist
 *   - onDisconnect    → flush partial text + persist (SW death recovery)
 *   - clearMessages() → empty array + persist
 *
 * NOT persisted:
 *   - chat-chunk      → React state only
 *   - agent-step      → React state only (M1-U3 hooks the SW-side
 *                       snapshot for agent IR; this is the panel-side
 *                       DisplayMessage stream)
 */

// deriveTitleFromMessages is imported from @/lib/sessions/title (lifted in M2-U3
// so the SW side can share the same sentinel string for the LLM title race guard).
// The DisplayMessage type satisfies TitleableMessage (has role + content fields).

/**
 * Schemes the agent loop refuses to operate on (mirrors `isRestrictedUrl`
 * in lib/agent/loop.ts). Kept inline here to avoid a panel→agent-runtime
 * import; if these two lists ever diverge the loop will hard-stop the
 * task on iteration 1 with "restricted URL" — but the panel UI would
 * have shown the session as pinnable, which is confusing. Easier to
 * filter at capture time so a restricted-URL session never gets a pin.
 */
const RESTRICTED_PIN_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "about:",
  "edge://",
  "file://",
  "data:",
  "javascript:",
  "blob:",
];

/**
 * M3-U2 — capture the user's currently-active tab + its origin so a new
 * session can anchor to it at creation time. Returns null when the
 * active tab can't be resolved (no window focused, restricted URL, etc.) —
 * the loop's first-iteration origin check would handle a slipped pin
 * defensively, but filtering here keeps the panel UX honest: a session
 * that displays as pinned should actually be runnable.
 *
 * Filters two layers:
 *   1. URL prefix list (chrome://, file://, blob:, etc.) — same as the
 *      loop's isRestrictedUrl. blob:https://example.com/abc parses to a
 *      non-"null" origin, so the prefix check (not origin equality) is
 *      what stops the pin from sneaking through.
 *   2. URL.origin === "null" — opaque-origin schemes the URL spec gives up on.
 */
async function captureActivePinned(): Promise<
  { pinnedTabId: number; pinnedOrigin: string } | null
> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null;
    // Chrome can return tab.id === -1 for session-restore / detached tabs.
    // The truthy check above lets that slip through (-1 is truthy). If we
    // persisted it, a downstream chrome.tabs.get(-1) would synchronously
    // throw "Value must be at least 0" and crash the agent loop. Filter
    // explicitly: only pin to a real, addressable tab.
    if (!Number.isInteger(tab.id) || tab.id < 0) return null;
    // file://*.pdf exception: PDF viewer is sealed, so URL itself is the pin
    // identity (mirrors loop.ts isFilePdfUrl handling).
    if (isFilePdfUrl(tab.url)) {
      return { pinnedTabId: tab.id, pinnedOrigin: tab.url };
    }
    if (RESTRICTED_PIN_PREFIXES.some((p) => tab.url!.startsWith(p))) return null;
    const origin = new URL(tab.url).origin;
    if (!origin || origin === "null") return null;
    return { pinnedTabId: tab.id, pinnedOrigin: origin };
  } catch {
    return null;
  }
}

interface SendMessageInput {
  /** What the user typed — rendered in the chat. */
  content: string;
  /** Slash-command expansion sent to the LLM in place of `content`. The
   *  user-facing message keeps the slash form. */
  expandedForLLM?: string;
  /** Phase 5 image attachments — included in the last user ChatMessage
   *  sent to the SW. NOT persisted to storage (scrubber policy from
   *  ChatMessage R10 storage note applies). */
  attachments?: ImageAttachment[];
  /** Issue #38 — quote chips that were staged at send time. The LLM-facing
   *  wrapper text already lives in `expandedForLLM`; this is the structured
   *  copy for the chat bubble to render without re-parsing. */
  quotes?: Quote[];
  /** FIX-B — file attachments staged at send time, for bubble display. */
  fileAttachments?: FileAttachment[];
}

export interface UseSession {
  sessionId: string | null;
  /** False until the initial storage read finishes. Consumers should
   *  disable input until this flips true to avoid the user racing the
   *  bootstrap and overwriting persisted history with an empty array. */
  ready: boolean;
  /** M1-U5 — current session status. App uses `paused` to surface the
   *  'Resume task' affordance. Updated via the store-bus "sessions" event so
   *  a SW cold-start mark transitions the UI without panel reload. */
  status: SessionStatus | null;
  /** v1.5 — persisted pinned tabs array from the active session's meta.
   *  null when the session has no pin yet (brand-new empty session or auto
   *  mode). Chat reads this to decide whether to display a frozen pin
   *  (messages.length > 0 → locked) or a live preview of the user's
   *  currently-active tab (empty session → free). Updated on bootstrap,
   *  setActive, and the store-bus "sessions" event for the active session's
   *  meta. Replaces single pinnedOrigin + pinnedTabId fields. */
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | null;
  /** M5 — pin state machine: 'auto' / 'task' / 'user' (or null pre-bootstrap).
   *  Drives Chat.tsx's isLocked decision and per-effect listener wiring. */
  pinMode: "auto" | "task" | "user" | null;
  messages: DisplayMessage[];
  streaming: boolean;
  streamingText: string;
  streamingThinking: string;
  error: string | null;
  /** 最近一次 chat-error 的机读分类（见 ErrorKind）。null = 无/未分类。
   *  驱动 Chat 错误气泡下的 managed CTA（budget→管理订阅 / auth→重登提示）。 */
  errorKind: import("@/lib/model-router/types").ErrorKind | null;
  /** M2-U2 — transient toast from the SW (e.g. SEC-PLAN-009 flood warn).
   *  Rendered by Chat as a dismissable banner. Not persisted. */
  toast: { level: "warn" | "error" | "info"; text: string } | null;
  /** Issue #38 v1 — per-session page content reference chips (not persisted). */
  quotes: ReadonlyArray<Quote>;
  /** Issue #59 — most recent context usage snapshot for the active session.
   *  Undefined until the first LLM call completes (ring is hidden in that
   *  state). Populated on setActive (cold path) and agent-usage wire events
   *  (hot path). */
  usage?: SessionAgentState["contextUsage"];
  /** Issue #34 — SW-broadcast snapshot of pending instructions for the active
   *  session. Keyed by chatMessageId for O(1) lookup in chat-bubble render.
   *  Empty Map when no instructions are pending. */
  pendingByChatMessageId: Map<string, { createdAt: number }>;
  sendMessage: (input: SendMessageInput) => void;
  /** Issue #34 — append a pending instruction during streaming. Generates a
   *  chatMessageId, writes the DisplayMessage into slot.messages (with id),
   *  and sends chat-instruction-add to the SW. No-op when not streaming. */
  addPendingInstruction: (input: SendMessageInput) => void;
  /** Issue #34 — cancel a pending instruction by chatMessageId. Removes the
   *  DisplayMessage from slot.messages and sends chat-instruction-cancel to
   *  the SW. Idempotent. */
  cancelPendingInstruction: (chatMessageId: string) => void;
  /** Sends a chat-abort message to the SW. Caller is responsible for
   *  guarding against rapid-fire aborts. */
  abort: () => void;
  /** M1-U5 — user clicks 'Resume task' on a paused session. SW
   *  decides whether to drift-card or restart the loop. */
  resumeTask: () => void;
  /** M1-U5 — user clicks 'Discard task' on the R11 drift card. */
  discardTask: (confirmationId: string) => void;
  /** Clears the message history both in React state and in storage. */
  clearMessages: () => Promise<void>;
  /** Allows Chat to dismiss the error banner without re-sending. */
  clearError: () => void;
  /** Dismiss the SEC-PLAN-009 toast. */
  clearToast: () => void;
  /**
   * M2-U2 — switch the active session. Loads the session's persisted
   * messages, bumps lastAccessedAt, and sends a panel-mounted handshake
   * on the existing port. Refuses if `streaming === true` (no abort
   * mid-stream; user must Stop first). Returns the new sessionId or null
   * if the switch was refused.
   */
  setActive: (id: string) => Promise<string | null>;
  /**
   * M2-U2 — create a new session and make it active. Returns the new
   * session's id, or null if refused because streaming is in progress
   * (P0-1 guard — mirror of setActive).
   */
  createAndActivate: () => Promise<string | null>;
  /**
   * v1.5 — user toggles a tab's membership in user-mode pinnedTabs[].
   * From auto: adds pin, flips mode → user. From user + existing pin:
   * removes pin (if last, flips back to auto). From user + new tab: appends.
   * From task: no-op (loop owns task-mode pins). No-op when no active session. */
  togglePinTab: (tabId: number, origin: string) => Promise<void>;
  /**
   * M5 — user clicks "Auto" in dropdown. Reverts pinMode='user' to 'auto'
   * and removes all pinned tabs. No-op for 'task' mode (loop-managed)
   * or already-auto sessions. */
  clearUserPin: () => Promise<void>;
  /** Issue #38 v1 — quote chip management methods. */
  addQuote: (sessionId: string, q: Quote) => void;
  removeQuote: (sessionId: string, quoteId: string) => void;
  clearQuotes: (sessionId: string) => void;
  /** Recording v1 — exposes the active per-session port so useRecording can
   *  attach its own onMessage listener. Null until ready=true. */
  port: chrome.runtime.Port | null;
  /** output_file — request the SW to download an artifact to disk. Sends an
   *  out-of-band download-output port message and resolves when the SW replies
   *  with file-output-result (or after a 30s safety timeout). */
  downloadOutput: (artifactId: string) => Promise<DownloadResult>;
}

export function useSession(): UseSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  // v1.5 — pinnedTabs[] replaces single pinnedOrigin/pinnedTabId state.
  const [pinnedTabsState, setPinnedTabsState] = useState<
    ReadonlyArray<{ tabId: number; origin: string }> | null
  >(null);
  // M5 — pin mode state machine: auto / task / user. Drives the Chat.tsx
  // isLocked decision (was: messages.length > 0; now: pinMode !== 'auto').
  const [pinMode, setPinModeState] = useState<"auto" | "task" | "user" | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const t = useT();

  // Multi-session (#30) — one Port per sessionId. Switching sessions does
  // NOT disconnect the previous port; SW continues delivering messages for
  // background tasks via createPortHandlers' single onMessage listener.
  // Cleanup: panel unmount disconnects every entry.
  const portsRef = useRef<Map<string, chrome.runtime.Port>>(new Map());
  const sessionIdRef = useRef<string | null>(null);

  const [slots, setSlots] = useState<Map<string, SessionRuntimeSlot>>(new Map());
  const slotsRef = useRef<Map<string, SessionRuntimeSlot>>(new Map());

  // Issue #34 — ref populated after postWithReconnect is created; passed into
  // createPortHandlers to break the portHandlers → connectPortFor → portHandlers
  // circular dependency while still letting chat-instruction-rejected fall back
  // to chat-start via the live postWithReconnect function.
  const postWithReconnectRef = useRef<((id: string, payload: PortMessageToWorker) => boolean) | null>(null);

  // patchSlot — sync write to slotsRef (Bug-fix-A truth source) + setSlots
  // for React commit.
  const patchSlot = useCallback(
    (
      id: string,
      patch:
        | Partial<SessionRuntimeSlot>
        | ((s: SessionRuntimeSlot) => Partial<SessionRuntimeSlot>),
    ) => {
      slotsRef.current = withSlot(slotsRef.current, id, patch);
      setSlots(slotsRef.current);
    },
    [],
  );

  // #30 — derive active session view; passed back through UseSession interface.
  const active = deriveActiveView(slots, sessionId);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Multi-session (#30) — sessionId-explicit variant for port handlers. The
  // legacy persistMessages (which reads sessionIdRef) is preserved during
  // migration and removed in Task 9b once all callers move off it.
  const persistMessagesById = useCallback(
    async (id: string, next: DisplayMessage[]) => {
      const current = await getSessionMeta(id);
      if (!current) return;
      if (current.status === "archived") return;
      const titlePatch =
        current.title === undefined || current.title === ""
          ? deriveTitleFromMessages(next)
          : undefined;
      await setSessionMeta({
        ...current,
        messages: next,
        lastAccessedAt: Date.now(),
        ...(titlePatch !== undefined ? { title: titlePatch } : {}),
      });
    },
    [],
  );

  // Multi-session (#30) — single onMessage listener routes by message.sessionId;
  // per-port disconnect closure flushes partial text scoped to that port's session.
  // Issue #34 — postMessageRef is passed so chat-instruction-rejected can fall
  // back to chat-start; the ref is populated after postWithReconnect is defined
  // to break the circular portHandlers → connectPortFor → portHandlers dep.
  const portHandlers = useMemo(
    () => createPortHandlers({
      slotsRef,
      setSlots,
      persistMessages: persistMessagesById,
      postMessageRef: postWithReconnectRef,
    }),
    [persistMessagesById],
  );

  // ── Mount: bootstrap active session + open per-session port ─────────
  // M3-U1 — port name is `chat-stream-${sessionId}`. The SW parses the
  // sessionId out of the name to anchor per-port state (abortController,
  // inFlightSessionIds). Switching active sessions
  // disconnects the old port and connects a fresh one for the new id;
  // single-panel concurrent task switch remains gated by the streaming
  // guard (deferred to a future M3 unit). Cross-panel concurrency (two
  // sidepanels in two windows) IS supported by the SW because each panel
  // gets its own port pinned to its own sessionId.
  const connectPortFor = useCallback(
    (id: string) => {
      const port = chrome.runtime.connect({ name: `chat-stream-${id}` });
      port.onMessage.addListener(portHandlers.handleMessage);
      const flushOnDisconnect = portHandlers.makeDisconnectHandler(id);
      port.onDisconnect.addListener(() => {
        // SW idle-out / crash 会让 port 在 panel 这侧静默断开。先丢掉 ref
        // 再 flush，下一次 send 才会通过 getOrReconnectPort 拿到新 port，
        // 而不是把消息塞进已经死掉的 handle 触发 "disconnected port" 抛错。
        // 身份比对保护手动 reconnect 场景：sibling 重连可能已写入新 port。
        if (portsRef.current.get(id) === port) {
          portsRef.current.delete(id);
        }
        flushOnDisconnect();
      });
      // panel-mounted 的 postMessage 也包 try：极端竞态下新建的 port 可能
      // 立刻死（SW 又在重启），不能让握手抛错冒出 connectPortFor —
      // postWithReconnect 后续的 tryOnce 会再次失败并走 revert 路径。
      try {
        port.postMessage({ type: "panel-mounted", sessionId: id });
      } catch (e) {
        console.warn(`[useSession] panel-mounted failed on fresh port for session=${id}:`, e);
      }
      return port;
    },
    [portHandlers],
  );

  // Lazy 重连：sendMessage / abort / resume / discard 共用。portsRef
  // 里没 entry（mount 时未连接 / SW idle-out 后被 onDisconnect 清理）
  // 时新建一条 port，否则复用现有的。
  const getOrReconnectPort = useCallback(
    (id: string): chrome.runtime.Port => {
      const existing = portsRef.current.get(id);
      if (existing) return existing;
      const fresh = connectPortFor(id);
      portsRef.current.set(id, fresh);
      return fresh;
    },
    [connectPortFor],
  );

  // postMessage 容错：disconnected port 上 postMessage 抛同步错误。
  // 一次失败静默重连重发；两次都失败返回 false 由 caller 决定如何 revert
  // UI 状态。SW 重启对用户完全透明 —— 新 port 上 panel-mounted 会触发
  // SW handlePanelMounted 从 storage 重建 session 状态。
  const postWithReconnect = useCallback(
    (id: string, payload: PortMessageToWorker): boolean => {
      const tryOnce = (p: chrome.runtime.Port): boolean => {
        try {
          p.postMessage(payload);
          return true;
        } catch {
          return false;
        }
      };
      let port = getOrReconnectPort(id);
      if (tryOnce(port)) return true;
      if (portsRef.current.get(id) === port) {
        portsRef.current.delete(id);
        try { port.disconnect(); } catch {}
      }
      port = getOrReconnectPort(id);
      return tryOnce(port);
    },
    [getOrReconnectPort],
  );

  // Issue #34 — populate the ref so port-handlers.ts chat-instruction-rejected
  // can call postWithReconnect without a circular useMemo dep.
  postWithReconnectRef.current = postWithReconnect;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Sweep stale empty active sessions left over from previous panel
        // mounts. We always create a fresh empty session below; the previous
        // mount's empty session would otherwise pile up forever in storage.
        // Heuristic guards:
        //   - status === "active" (paused/failed/archived must be preserved
        //     so the user can find their work in the drawer)
        //   - messageCount === 0 (per the M2 lock-on-send rule, only sessions
        //     with no DisplayMessages are candidates for cleanup)
        //   - lastAccessedAt < now - 60s (protect sibling-window panels that
        //     just created a fresh empty session and haven't sent a message
        //     yet — their entry is < 60s old, leave it alone)
        //   - lastAccessedAt > REAL_CLOCK_MIN (defends against tests that
        //     use fake clocks like `now: 1000` to set up scenarios — those
        //     timestamps fall outside any plausible real-clock range and
        //     should not be GC targets)
        const STALE_EMPTY_MS = 60_000;
        const REAL_CLOCK_MIN_MS = 1_000_000_000_000; // 2001-09-09
        const now = Date.now();
        const list = await listSessionIndex();
        if (cancelled) return;
        for (const entry of list) {
          if (entry.status !== "active") continue;
          if ((entry.messageCount ?? 1) > 0) continue;
          if (entry.lastAccessedAt < REAL_CLOCK_MIN_MS) continue;
          if (now - entry.lastAccessedAt < STALE_EMPTY_MS) continue;
          await hardDeleteSession(entry.id);
          if (cancelled) return;
        }

        // Always start a fresh, empty, unpinned session. The user's first
        // sendMessage captures the pin and bumps messageCount, which makes
        // the session visible in the drawer. Previous behavior reloaded
        // list[0]; the user requested every panel open start clean.
        const meta = await createSession();
        if (cancelled) return;
        setSessionId(meta.id);
        setStatus(meta.status);
        setPinnedTabsState(null);
        setPinModeState(meta.pinMode ?? "auto");
        patchSlot(meta.id, EMPTY_SLOT);
        portsRef.current.set(meta.id, connectPortFor(meta.id));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
      // #30 — disconnect every port. Each disconnect triggers the SW's
      // port.onDisconnect: transitionPortInFlightSessionsToPaused marks any
      // in-flight session for that port as paused (R10/R14 invariant).
      for (const port of portsRef.current.values()) {
        try { port.disconnect(); } catch {}
      }
      portsRef.current.clear();
    };
  }, [connectPortFor]);

  // Bug-fix — quote reconnect nudge. When the user captures a page quote while
  // this panel is still mounted on its current session but the SW idled/restarted
  // (silently killing the streaming port — panel only reconnects lazily on the
  // next send), the SW has no live port to deliver to, stashes the quote, and
  // broadcasts `quote-needs-reconnect` over runtime messaging (which survives the
  // dead port). We respond by force-reconnecting the *current* session's port:
  // since the SW stashed only because it had zero live ports, our cached handle
  // is stale, so we drop it and reconnect. The SW's onConnect then drains the
  // pending quote into THIS session — where the user is actually looking —
  // instead of leaking it into the next (often blank) session that connects.
  useEffect(() => {
    const onRuntimeMessage = (msg: unknown) => {
      if (
        typeof msg !== "object" ||
        msg === null ||
        (msg as { type?: unknown }).type !== "quote-needs-reconnect"
      ) {
        return;
      }
      const id = sessionIdRef.current;
      if (!id) return;
      const stale = portsRef.current.get(id);
      if (stale) {
        try { stale.disconnect(); } catch {}
        portsRef.current.delete(id);
      }
      portsRef.current.set(id, connectPortFor(id));
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  }, [connectPortFor]);

  // M1-U5 — track status changes from SW writes (cold-start
  // detectAndMarkPaused, post-resume markActive). Without this, the
  // panel would never see the SW transition from `active` to `paused`
  // after a SW death + wake-up that the user didn't trigger via
  // closing/reopening the panel.
  //
  // Post-IDB-migration: the chrome.storage onChanged signal (which carried
  // the per-key `newValue`) is gone. We now ride the coarse store-bus
  // "sessions" event and re-read the active session's meta from IDB. Behavior
  // is equivalent: the refetched meta is the authoritative persisted state.
  // We re-read on EVERY "sessions" event (the bus is coarse / id-less for
  // batch writes) and apply the same adoption rules to the fetched meta.
  useStoreChange("sessions", () => {
    const sid = sessionId;
    if (!sid) return;
    void (async () => {
      const newMeta = await getSessionMeta(sid);
      // The active session changed out from under us while awaiting — bail.
      if (sessionIdRef.current !== sid) return;
      // Status update is always adopted — the SW transitions (paused→active,
      // active→failed) must land even mid-stream (e.g. SW cold-start marking
      // a task paused while the panel thinks it's still running).
      if (newMeta?.status !== undefined) setStatus(newMeta.status);
      // v1.5 — propagate pinMode + pinnedTabs[]. Subtle invariant:
      // when SW transitions task → auto via clearTaskPinIfActive, it
      // `delete`s pinnedTabs from the meta object. The deleted
      // field is NOT present in newValue, so a `newMeta?.pinnedTabs
      // !== undefined` check would never fire and panel state would
      // retain the stale pin. Fix: when pinMode flips to 'auto' explicitly,
      // force-clear pin state to match the storage invariant ("auto mode
      // never persists pin"). For task/user transitions, adopt the pin
      // fields normally.
      if (newMeta?.pinMode !== undefined) {
        setPinModeState(newMeta.pinMode);
        if (newMeta.pinMode === "auto") {
          // Auto mode invariant: pinnedTabs is absent. Mirror that in panel state.
          setPinnedTabsState(null);
        }
      }
      if (newMeta?.pinnedTabs !== undefined) {
        const pins = newMeta.pinnedTabs;
        setPinnedTabsState(pins.length > 0 ? pins : null);
      }
      if (newMeta?.messages !== undefined) {
        // P1-6 + Bug-fix-A — prevent self-write echo AND stale SW write-back
        // overwriting authoritative panel state.
        //
        // 1. During streaming: NEVER adopt the SW's messages. makeStepSnapshotHandler
        //    bumps updateLastAccessed every 5 steps which writes meta with the last
        //    persisted messages → onChanged fires. handleChatStream also
        //    fire-and-forgets updateLastAccessed at chat-start, which writes
        //    meta back with the messages snapshot taken BEFORE the panel had
        //    a chance to persist the user's just-sent message — that one would
        //    silently overwrite the user message if we adopted it.
        //
        // 2. Not streaming: skip self-echo (content equality) AND stale-prefix
        //    write-back (remote.length < local.length AND remote is a strict
        //    prefix of local). Both are signs the SW round-tripped a stale meta
        //    after the panel's authoritative state moved forward.
        if (slotsRef.current.get(sessionIdRef.current ?? "")?.streaming) {
          return;
        }
        const local = slotsRef.current.get(sid)?.messages ?? [];
        const remote = newMeta.messages;
        if (remote.length === local.length) {
          if (JSON.stringify(remote) === JSON.stringify(local)) {
            return; // self-write echo — no-op
          }
        } else if (remote.length < local.length) {
          // Strict-prefix check: SW wrote a stale-shorter messages array.
          // Compare element-by-element; if every remote[i] equals local[i],
          // the SW write is a stale snapshot → ignore.
          let isPrefix = true;
          for (let i = 0; i < remote.length; i++) {
            if (JSON.stringify(remote[i]) !== JSON.stringify(local[i])) {
              isPrefix = false;
              break;
            }
          }
          if (isPrefix) return;
        }
        patchSlot(sid, { messages: remote });
      }
    })();
  });

  // ── sendMessage ────────────────────────────────────────────────────
  // M1-U4 mount-immediate connection + transparent reconnect: panel mount
  // 时建立 port，SW idle-out / 崩溃后 panel 这侧的 port 会自动断开 +
  // 被 onDisconnect 从 portsRef 清掉。sendMessage 通过 postWithReconnect
  // 自动 lazy 重连一次。两次都失败才 revert streaming 标记并暴露 error。
  const sendMessage = useCallback(
    (input: SendMessageInput) => {
      if (slotsRef.current.get(sessionIdRef.current ?? "")?.streaming) return;
      const id = sessionIdRef.current;
      if (!id) return;
      const userMessage: DisplayMessage = {
        role: "user",
        content: input.content,
        ...(input.expandedForLLM !== undefined
          ? { expandedForLLM: input.expandedForLLM }
          : {}),
        // Phase 5 — carry attachments on the display message so past turns
        // can render thumbnails (image kind) or '[图已释放]' badges
        // (image_placeholder kind after R10 storage scrub). Mirror the
        // expandedForLLM spread pattern: absent when no attachments.
        ...(input.attachments?.length
          ? { attachments: input.attachments }
          : {}),
        ...(input.quotes?.length ? { quotes: input.quotes } : {}),
        ...(input.fileAttachments?.length ? { fileAttachments: input.fileAttachments } : {}),
      };
      const currentMessages = slotsRef.current.get(id)?.messages ?? [];
      const updated = [...currentMessages, userMessage];
      // M3-U2 (post-acceptance) — empty→non-empty is the moment we lock
      // the pin. Capture HERE rather than at session create / activation
      // so the user's actual at-send tab wins over their at-create tab.
      // Empty session: panel UI shows live-current-tab preview;
      // first sendMessage: capture + persist; from then on locked.
      const isFirstMessage = currentMessages.length === 0;
      patchSlot(id, {
        messages: updated,
        streaming: true,
        streamFinished: false,
        accumulated: "",
        streamingText: "",
        streamingThinking: "",
        error: null,
        errorKind: null,
      });

      // Build the LLM-facing chat history (text-only, slash-expanded).
      // Phase 5: the very last user ChatMessage carries image attachments
      // (passed via input.attachments) so the LLM sees them. Attachments
      // are only on the most-recent turn — historical turns are storage-
      // scrubbed (placeholder only, no data bytes) per the R10 policy.
      const flatUserAssistant = updated.filter(
        (
          m,
        ): m is
          | { role: "user"; content: string; expandedForLLM?: string }
          | { role: "assistant"; content: string } =>
          m.role === "user" || m.role === "assistant",
      );
      const chatMessages: ChatMessage[] = flatUserAssistant.map((m, idx) => {
        const isLastUserTurn =
          idx === flatUserAssistant.length - 1 && m.role === "user";
        if (m.role === "user" && m.expandedForLLM) {
          return {
            role: "user" as const,
            content: m.expandedForLLM,
            ...(isLastUserTurn && input.attachments?.length
              ? { attachments: input.attachments }
              : {}),
          };
        }
        return {
          role: m.role,
          content: m.content,
          ...(isLastUserTurn && input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
        };
      });

      // Bug-fix-C — persist immediately so the session_index entry picks
      // up the first-user-message title fallback (via persistMessages →
      // deriveTitleFromMessages → setSessionMeta atomic index update).
      // Without this, the top bar + drawer would keep saying "New
      // Session" until the model's reply lands at chat-done. Persisting
      // also defends against Bug 1: it makes the panel's authoritative
      // messages the on-disk version before any SW updateLastAccessed
      // round-trip can write back a stale shorter snapshot.
      // Fire-and-forget; failures are non-fatal.
      void persistMessagesById(id, updated);

      const sent = postWithReconnect(id, {
        type: "chat-start",
        messages: chatMessages,
        sessionId: id,
      });
      if (!sent) {
        // SW 连续两次拒收（罕见：连重连后的新 port 也立刻死）→ 撤回
        // streaming 状态让用户能再次发送。用户消息已经持久化到 storage，
        // 不会丢；下次 sendMessage 会基于现有 messages 数组继续追加。
        patchSlot(id, {
          streaming: false,
          streamFinished: true,
          error: t("errors.connectBackgroundFailedRetry"),
        });
        return;
      }

      // M3-U2 (post-acceptance) — pin capture is a separate
      // fire-and-forget that ONLY patches pinnedTabId / pinnedOrigin
      // (never `messages`). Critical: the chat-done handler also calls
      // persistMessages(next-with-assistant). If the pin patch wrote
      // `messages: updated` (the [user]-only snapshot) it could
      // overwrite chat-done's [user, assistant] write under microtask
      // ordering. Patching pin separately keeps the message persistence
      // path untouched.
      //
      // First-task ordering note: SW's handleChatStream may read meta
      // BEFORE the pin patch lands → ctx.pinnedTabs is empty → the
      // loop falls back to chrome.tabs.query active-tab. That fallback
      // returns the same tab the user just sent from (no tab switch in
      // the microsecond gap), so the first task pins to the right tab
      // via fallback. Subsequent chat-starts read the patched pin via
      // ctx directly.
      if (isFirstMessage) {
        void (async () => {
          try {
            const meta = await getSessionMeta(id);
            if (!meta || meta.status === "archived") return;
            // v1.5 — skip if already has pinnedTabs[]
            if (meta.pinnedTabs && meta.pinnedTabs.length > 0) return;
            const pin = await captureActivePinned();
            if (!pin) return;
            // Re-read in case something else patched in the meantime.
            const fresh = await getSessionMeta(id);
            if (!fresh || fresh.status === "archived") return;
            if (fresh.pinnedTabs && fresh.pinnedTabs.length > 0) return;
            const pinEntry = { tabId: pin.pinnedTabId, origin: pin.pinnedOrigin };
            await setSessionMeta({
              ...fresh,
              // M5 — first-message capture is the task-mode upgrade. Set
              // pinMode='task' so the storage normalize-on-write invariant
              // (auto mode never persists pin) doesn't strip it.
              pinMode: "task",
              // v1.5 — write source-of-truth pinnedTabs[].
              pinnedTabs: [pinEntry],
              lastAccessedAt: Date.now(),
            });
            setPinnedTabsState([pinEntry]);
            setPinModeState("task");
          } catch (e) {
            console.warn("[useSession] pin patch on first send failed:", e);
          }
        })();
      }
    },
    [persistMessagesById, patchSlot, postWithReconnect],
  );

  // ── addPendingInstruction ─────────────────────────────────────────────
  // Issue #34 — appends a user DisplayMessage (with a stable id) to the
  // slot and sends chat-instruction-add to the SW. Only valid during
  // streaming; ignored otherwise. Uses crypto.randomUUID as the panel has
  // no ulid dependency.
  const addPendingInstruction = useCallback(
    (input: SendMessageInput) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const slot = slotsRef.current.get(id);
      if (!slot?.streaming) return; // safety: only during streaming
      const chatMessageId = crypto.randomUUID();
      const userMessage: DisplayMessage = {
        role: "user",
        content: input.content,
        id: chatMessageId,
        ...(input.expandedForLLM !== undefined
          ? { expandedForLLM: input.expandedForLLM }
          : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.quotes?.length ? { quotes: input.quotes } : {}),
        ...(input.fileAttachments?.length ? { fileAttachments: input.fileAttachments } : {}),
      };
      const updated = [...(slot.messages ?? []), userMessage];
      patchSlot(id, { messages: updated });
      void persistMessagesById(id, updated);

      postWithReconnect(id, {
        type: "chat-instruction-add",
        sessionId: id,
        chatMessageId,
        content: input.content,
        ...(input.expandedForLLM !== undefined
          ? { expandedForLLM: input.expandedForLLM }
          : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.quotes?.length ? { quotes: input.quotes } : {}),
      });
    },
    [patchSlot, persistMessagesById, postWithReconnect],
  );

  // ── cancelPendingInstruction ──────────────────────────────────────────
  // Issue #34 — removes the DisplayMessage with the given id from slot.messages
  // and sends chat-instruction-cancel to the SW. Idempotent.
  const cancelPendingInstruction = useCallback(
    (chatMessageId: string) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const slot = slotsRef.current.get(id);
      if (!slot) return;
      const updated = (slot.messages ?? []).filter(
        (m) => !("id" in m && m.id === chatMessageId),
      );
      patchSlot(id, { messages: updated });
      void persistMessagesById(id, updated);

      postWithReconnect(id, {
        type: "chat-instruction-cancel",
        sessionId: id,
        chatMessageId,
      });
    },
    [patchSlot, persistMessagesById, postWithReconnect],
  );

  const abort = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return;
    // chat-abort 走 lazy 重连：若 SW 已 idle-out，新建 port 让 SW 重启后
    // 收到 abort（无运行 task 时 SW 静默忽略）。两次失败也无副作用 ——
    // panel disconnect handler 已经把 streaming 翻成 false。
    postWithReconnect(id, { type: "chat-abort" });
  }, [postWithReconnect]);

  const resumeTask = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return;
    patchSlot(id, {
      streaming: true,
      accumulated: "",
      streamFinished: false,
      error: null,
      errorKind: null,
    });
    const sent = postWithReconnect(id, { type: "resume-task", sessionId: id });
    if (!sent) {
      // 两次重连均失败 — 撤回 streaming 标记，否则 UI 卡在 spinner。
      patchSlot(id, { streaming: false, streamFinished: true });
    }
  }, [patchSlot, postWithReconnect]);

  const discardTask = useCallback((confirmationId: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    // discard 是确认型操作，wire 失败不阻塞 panel 侧 resolved 标记：
    // 即便 SW 没收到，下次 panel mount 时 confirmation 已被 panel
    // 标 discarded，不会再追踪。
    postWithReconnect(id, {
      type: "discard-task",
      sessionId: id,
      confirmationId,
    });
    patchSlot(id, (prev) => ({
      messages: prev.messages.map((m) =>
        m.role === "session-confirm" && m.confirmationId === confirmationId
          ? { ...m, resolved: "discarded" as const }
          : m,
      ),
    }));
  }, [patchSlot, postWithReconnect]);

  const clearMessages = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    patchSlot(id, { messages: [], error: null, errorKind: null, toast: null });
    await persistMessagesById(id, []);
  }, [patchSlot, persistMessagesById]);

  const clearError = useCallback(() => {
    if (sessionIdRef.current) patchSlot(sessionIdRef.current, { error: null, errorKind: null });
  }, [patchSlot]);
  const clearToast = useCallback(() => {
    if (sessionIdRef.current) patchSlot(sessionIdRef.current, { toast: null });
  }, [patchSlot]);

  /**
   * M2-U2 — switch active session. Refuses when streaming is true
   * (no per-session port yet; M3 will allow this).
   *
   * On switch:
   *   1. Loads persisted messages for the new session from storage.
   *   2. Bumps lastAccessedAt so LRU order reflects user interaction.
   *   3. Sends panel-mounted on the existing port so the SW re-emits
   *      any live session-confirm for the new session.
   */
  const setActive = useCallback(async (id: string): Promise<string | null> => {
    // #30 — streaming guard removed: switching sessions no longer kills tasks.
    // Old port stays connected; SW keeps streaming into its session's slot.

    const meta = await getSessionMeta(id);
    if (!meta) return null;
    if (sessionIdRef.current === id) return id;

    // Issue #59 — read the agent state so we can rehydrate slot.usage for the
    // cold-path (session switch or panel mount on an existing session). The SW
    // pushes agent-usage events live during a streaming task; setActive handles
    // the non-streaming case so the context ring shows immediately on switch.
    const agent = await getSessionAgent(id);

    // Legacy-pin migration (M3-U2 post-acceptance) — preserved verbatim.
    let metaForActivate = meta;
    let didMigrate = false;
    const sessionHasContent = (meta.messages?.length ?? 0) > 0;
    if (sessionHasContent && (!meta.pinnedTabs || meta.pinnedTabs.length === 0)) {
      const pinned = await captureActivePinned();
      if (pinned) {
        const pinEntry = { tabId: pinned.pinnedTabId, origin: pinned.pinnedOrigin };
        const patched = {
          ...meta,
          pinMode: "task" as const,
          pinnedTabs: [pinEntry],
          lastAccessedAt: Date.now(),
        };
        await setSessionMeta(patched);
        metaForActivate = patched;
        didMigrate = true;
      }
    }
    if (!didMigrate) await updateLastAccessed(id);

    sessionIdRef.current = id;
    setSessionId(id);
    setStatus(metaForActivate.status);
    const activatePins = metaForActivate.pinnedTabs;
    setPinnedTabsState(activatePins && activatePins.length > 0 ? activatePins : null);
    setPinModeState(metaForActivate.pinMode ?? "auto");

    // Multi-session: hydrate slot from storage IFF the slot doesn't already
    // hold streaming state (a background task on this session would have
    // a live slot already; do not clobber it with stale storage messages).
    patchSlot(id, (prev) => {
      if (prev.streaming) return {}; // keep live slot intact
      return {
        messages: metaForActivate.messages ?? [],
        error: null,
        errorKind: null,
        toast: null,
        accumulated: "",
        streamingText: "",
        streamingThinking: "",
        streaming: false,
        streamFinished: true,
        usage: agent?.contextUsage, // Issue #59 — rehydrate context ring data
      };
    });

    // §3.4 invariant — paused / archived sessions do NOT auto-create a port.
    // Resume / archived-readonly flows decide explicitly when to connect.
    if (
      !portsRef.current.has(id) &&
      metaForActivate.status !== "archived" &&
      metaForActivate.status !== "paused"
    ) {
      portsRef.current.set(id, connectPortFor(id));
    }

    return id;
  }, [connectPortFor, patchSlot]);

  /**
   * M2-U2 — create a new session and make it active. Returns the new
   * session's id, or null if refused (streaming in progress). Does not
   * open a new port (M3-U1 concern); reuses the existing port with a
   * new panel-mounted announce.
   *
   * P0-1 guard: refuses when streaming=true (mirror of setActive guard).
   * Without this, messages from a still-running agent loop would route
   * into the new session's UI.
   */
  const createAndActivate = useCallback(async (): Promise<string | null> => {
    // #30 — streaming guard removed; old port stays connected for the
    // background task. SW already supports concurrent ports per PR #29.
    const meta = await createSession();
    sessionIdRef.current = meta.id;
    setSessionId(meta.id);
    setStatus(meta.status);
    setPinnedTabsState(null);
    setPinModeState("auto");
    patchSlot(meta.id, EMPTY_SLOT);
    portsRef.current.set(meta.id, connectPortFor(meta.id));
    return meta.id;
  }, [connectPortFor, patchSlot]);

  // v1.5 — PinnedTabDropdown actions. Direct IDB writes (panel can write
  // session_${id}_meta) — no need to round-trip through SW. The store-bus
  // subscriber in this same hook picks up the change and updates local state,
  // mirroring the user's choice instantly.
  const togglePinTab = useCallback(
    async (tabId: number, origin: string): Promise<void> => {
      const id = sessionIdRef.current;
      if (!id) return;
      const meta = await getSessionMeta(id);
      if (!meta) return;
      const next = togglePinTabUserMode(meta, { tabId, origin });
      if (next === meta) return; // no-op (e.g. task mode)
      await setSessionMeta(next);
      // Mirror in local state immediately so UI reflects the choice without
      // waiting for storage onChanged round-trip.
      const nextPins = next.pinnedTabs;
      setPinnedTabsState(nextPins && nextPins.length > 0 ? nextPins : null);
      setPinModeState(next.pinMode ?? "auto");
    },
    [],
  );

  const clearUserPin = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) return;
    const meta = await getSessionMeta(id);
    if (!meta) return;
    if (meta.pinMode !== "user") return; // only user mode is user-clearable
    // v1.5 — `delete next.pinnedTabs` is LOAD-BEARING here (not cosmetic):
    // storage's syncLegacyFromArray dual-write shim re-synthesizes legacy
    // pinnedTabId/pinnedOrigin from `pinnedTabs[0]` on every persist. If we
    // left `pinnedTabs` on the meta and only flipped pinMode to 'auto', the
    // shim would resurrect the legacy fields from the leftover array, leaving
    // the session pinned despite the user's clear-pin action.
    const next = { ...meta, pinMode: "auto" as const };
    delete (next as { pinnedTabs?: SessionMeta["pinnedTabs"] }).pinnedTabs;
    await setSessionMeta(next);
    setPinModeState("auto");
    setPinnedTabsState(null);
  }, []);

  // Issue #38 v1 — quote chip management
  const addQuote = useCallback((sessionId: string, q: Quote) => {
    slotsRef.current = withSlot(slotsRef.current, sessionId, (s) => ({ quotes: [...s.quotes, q] }));
    setSlots(slotsRef.current);
  }, []);

  const removeQuote = useCallback((sessionId: string, quoteId: string) => {
    slotsRef.current = withSlot(slotsRef.current, sessionId, (s) => ({ quotes: s.quotes.filter((q) => q.id !== quoteId) }));
    setSlots(slotsRef.current);
  }, []);

  const clearQuotes = useCallback((sessionId: string) => {
    slotsRef.current = withSlot(slotsRef.current, sessionId, { quotes: [] });
    setSlots(slotsRef.current);
  }, []);

  // output_file — send an out-of-band download-output message over the active
  // session's port and return a promise that resolves when the SW replies with
  // file-output-result (or expires after 30 s).
  const downloadOutput = useCallback((artifactId: string): Promise<DownloadResult> => {
    const sid = sessionIdRef.current;
    if (!sid) return Promise.resolve({ status: "error" as const });
    return new Promise<DownloadResult>((resolve) => {
      registerDownload(artifactId, resolve);
      const port = getOrReconnectPort(sid);
      try {
        port.postMessage({ type: "download-output", artifactId });
      } catch {
        resolveDownload(artifactId, { status: "error" });
        return;
      }
      window.setTimeout(() => resolveDownload(artifactId, { status: "error" }), 30_000);
    });
  }, [getOrReconnectPort]);

  return {
    sessionId,
    port: sessionIdRef.current ? (portsRef.current.get(sessionIdRef.current) ?? null) : null,
    ready,
    status,
    pinnedTabs: pinnedTabsState,
    pinMode,
    messages: active.messages,
    streaming: active.streaming,
    streamingText: active.streamingText,
    streamingThinking: active.streamingThinking,
    error: active.error,
    errorKind: active.errorKind,
    toast: active.toast,
    quotes: active.quotes,
    usage: active.usage, // Issue #59
    pendingByChatMessageId: active.pendingByChatMessageId, // Issue #34
    sendMessage,
    addPendingInstruction, // Issue #34
    cancelPendingInstruction, // Issue #34
    abort,
    resumeTask,
    discardTask,
    clearMessages,
    clearError,
    clearToast,
    setActive,
    createAndActivate,
    togglePinTab,
    clearUserPin,
    addQuote,
    removeQuote,
    clearQuotes,
    downloadOutput,
  };
}
