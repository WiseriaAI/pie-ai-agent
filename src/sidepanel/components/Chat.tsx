import { useState, useEffect, useRef, useMemo } from "react";
import type { SkillPackage } from "@/lib/skills";
import {
  getEnabledSkillPackages,
  resolveSlashCommand,
  expandSlashCommand,
  normalizeSkillSlashKey,
} from "@/lib/skills";
import { resolveModelMeta, getProviderMeta } from "@/lib/model-router/providers/registry";
import { resolveSupportsVision } from "./chat-vision";
import ContextRing from "./ContextRing";
import { listInstances, getInstance, updateInstance, type DecryptedInstance } from "@/lib/instances";
import { resolveSelection } from "@/lib/model-selection-resolver";
import { setLastModelSelection } from "@/lib/last-model-selection";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import type { ImageAttachment } from "@/lib/images";
import type { FileAttachment } from "@/lib/files/types";
import { processPickedFile } from "@/lib/files/process-picked-file";
import { fileAttachmentToWrapper } from "@/lib/files/inject";
import { CollapsibleText } from "./CollapsibleText";
import { FileChip } from "./FileChip";
import { QuoteGlyph } from "./icons";
import type { UseSession } from "@/sidepanel/hooks/useSession";
import AgentStepGroup, { type AgentStepData } from "./AgentStepGroup";
import PinnedTabDropdown from "./PinnedTabDropdown";
import type { DisplayMessage } from "@/types";
import { QuoteChip } from "./QuoteChip";
import { escapeWrapperAttribute } from "@/lib/agent/untrusted-wrappers";
import type { Quote, TextQuote, ElementQuote } from "@/types";
import ModelPicker from "./ModelPicker";
import ThinkingSection from "./ThinkingSection";
import { useT } from "@/lib/i18n";
import { useStoreChange } from "@/sidepanel/hooks/useStoreChange";
import {
  getSessionMeta,
  setSessionMeta,
} from "@/lib/sessions/storage";

const MAX_IMAGES_PER_TURN = 3;

// Display segment for the chat scrollback. Consecutive agent-step messages
// collapse into a single "steps" segment so the panel renders one
// AgentStepGroup instead of N stacked cards.
type RenderSegment =
  | { kind: "msg"; firstIndex: number; msg: DisplayMessage }
  | {
      kind: "steps";
      firstIndex: number;
      doneSteps: AgentStepData[];
      currentStep: AgentStepData;
    };

function buildSegments(messages: readonly DisplayMessage[]): RenderSegment[] {
  const out: RenderSegment[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role !== "agent-step") {
      out.push({ kind: "msg", firstIndex: i, msg: m });
      i++;
      continue;
    }
    const start = i;
    const steps: AgentStepData[] = [];
    while (i < messages.length && messages[i]!.role === "agent-step") {
      const s = messages[i]! as Extract<DisplayMessage, { role: "agent-step" }>;
      steps.push({
        stepIndex: s.stepIndex,
        tool: s.tool,
        args: s.args,
        resolvedElement: s.resolvedElement,
        status: s.status,
        observation: s.observation,
        image: s.image,
      });
      i++;
    }
    const currentStep = steps[steps.length - 1]!;
    const doneSteps = steps.slice(0, -1);
    out.push({ kind: "steps", firstIndex: start, doneSteps, currentStep });
  }
  return out;
}
import AgentSummary from "./AgentSummary";
import SessionConfirmCard from "./SessionConfirmCard";
import MarkdownContent from "./Markdown";
import SkillSlashPopover from "./SkillSlashPopover";
import { PendingInstructionList, type PendingItem } from "./PendingInstructionList";
import { useCdpOnboarding } from "../hooks/useCdpOnboarding";
import { CdpOnboardingCard } from "./CdpOnboardingCard";
import { useLocalFileRequest } from "../hooks/useLocalFileRequest";
import { LocalFileRequestCard } from "./LocalFileRequestCard";
import { useFileAccessPrompt } from "../hooks/useFileAccessPrompt";
import { FileAccessCard } from "./FileAccessCard";
import { FileOutputCard } from "./FileOutputCard";
import { artifactExists } from "@/lib/files/output-store";

interface ChatProps {
  providerLabel: string | null;
  onOpenSettings: () => void;
  prefillInput?: string;
  onPrefillConsumed?: () => void;
  /** Session state owned by App so port + onMessage listener survive
   *  Chat unmounts (Settings sub-view swap). */
  session: UseSession;
  /** Recording v1 (Reframe 2026-05-05) — present after RecordingMode "Finish".
   *  Renders a chip above the input and on Send injects into expandedForLLM
   *  as args to the create_skill_from_recording built-in skill. */
  pendingRecording?: { trace: string; stepCount: number } | null;
  /** Called when user × the chip OR Send consumes the trace. */
  onPendingRecordingConsumed?: () => void;
  /** Recording v1 — Composer renders the [● REC] button when this is provided.
   *  Click triggers a recording-start; the panel switches to RecordingMode on
   *  the next broadcast. */
  onStartRecording?: () => void;
}

function filterAndSortSkillsForSlash(
  query: string,
  skills: SkillPackage[],
): SkillPackage[] {
  const q = normalizeSkillSlashKey(query);
  const scored: Array<{ skill: SkillPackage; score: number }> = [];
  for (const s of skills) {
    const slug = normalizeSkillSlashKey(s.frontmatter.name);
    const id = s.id.toLowerCase();
    let score = 0;
    if (q === "") {
      score = 1;
    } else if (slug === q || id === q) {
      score = 100;
    } else if (slug.startsWith(q)) {
      score = 60;
    } else if (id.startsWith(q)) {
      score = 50;
    } else if (slug.includes(q)) {
      score = 30;
    } else if (id.includes(q)) {
      score = 20;
    }
    if (score > 0) scored.push({ skill: s, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.skill.createdAt ?? 0) - (a.skill.createdAt ?? 0); // SkillPackage.createdAt is always set
  });
  return scored.map((x) => x.skill);
}

export default function Chat({
  providerLabel,
  onOpenSettings,
  prefillInput,
  onPrefillConsumed,
  session,
  pendingRecording,
  onPendingRecordingConsumed,
  onStartRecording,
}: ChatProps) {
  const {
    ready,
    messages,
    streaming,
    streamingText,
    streamingThinking,
    error,
    toast,
    pinnedTabs,
    pinMode,
    togglePinTab,
    clearUserPin,
    sendMessage: sessionSendMessage,
    abort,
    clearMessages,
    clearError,
    clearToast,
    quotes,
    addQuote,
    removeQuote,
    clearQuotes,
    port,
    usage,
    status,
    addPendingInstruction,
    cancelPendingInstruction,
    pendingByChatMessageId,
  } = session;
  // Derive convenience aliases from pinnedTabs[] for the locked-pin display.
  // Primary pin is the first entry (oldest / chat-start anchor).
  const sessionPinnedOrigin = pinnedTabs?.[0]?.origin ?? null;
  const sessionPinnedTabId = pinnedTabs?.[0]?.tabId ?? null;
  const [input, setInput] = useState("");
  const [hasConfig, setHasConfig] = useState<boolean | null>(null);
  const [pageChanged, setPageChanged] = useState(false);
  const t = useT();
  // M5 — PinnedTabDropdown open state. Lives in Chat (not the dropdown
  // itself) because the dropdown's anchor is the PINNED row in the info bar.
  const [pinDropdownOpen, setPinDropdownOpen] = useState(false);
  // Keep the dropdown mounted through its leave animation: `open` drives the
  // animation direction; `visible` drives actual mount/unmount (set false only
  // once the dropdown reports its leave animation finished via onExited).
  const [pinDropdownVisible, setPinDropdownVisible] = useState(false);
  const pinAnchorRef = useRef<HTMLButtonElement>(null);
  const [pickerActive, setPickerActive] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<SkillPackage[]>([]);
  const [popoverSelected, setPopoverSelected] = useState(0);
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  // Live preview of the user's currently-active tab origin + title. Only
  // used when the session is in 'auto' mode — then the user can still
  // freely tab-switch and the panel reflects "the tab your next first-
  // message will lock to". In 'task'/'user' mode, the display flips to
  // the persisted `sessionPinnedOrigin` + `lockedPinnedTitle` (frozen).
  const [livePinnedOrigin, setLivePinnedOrigin] = useState<string | null>(null);
  const [livePinnedTitle, setLivePinnedTitle] = useState<string | null>(null);
  // M5 follow-up — locked pin's title (task / user mode). Read from
  // chrome.tabs.get(sessionPinnedTabId); refreshed on onUpdated when the
  // tab itself changes title (most pages update document.title async).
  // null = not yet fetched / tab closed → fall back to host display.
  const [lockedPinnedTitle, setLockedPinnedTitle] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Stick-to-bottom: track whether the user is currently near the bottom and
  // only auto-scroll in that case, using an INSTANT jump (not smooth). When we
  // are already pinned to the bottom — e.g. the loop just exited and appended
  // its summary — an instant jump to the unchanged position is a no-op, so the
  // visible "re-scroll" wobble is gone. Scrolling up to read mid-stream is no
  // longer hijacked back to the bottom.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Phase 5 image input state
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [resizing, setResizing] = useState<Set<string>>(new Set());
  const [supportsVision, setSupportsVision] = useState<boolean>(false);
  const [maxContextTokens, setMaxContextTokens] = useState<number | undefined>(undefined);
  const [attachLocalToast, setAttachLocalToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Synchronous submit lock — the `streaming` / cleared-`input` guards only
  // take effect after a React re-render commits, so rapid double-Enter (or
  // double-click on Send) in the same frame would dispatch the same message
  // twice. The ref locks at dispatch time and is released after the next
  // commit (see the dep-less effect below), when the state guards take over.
  const submitLockRef = useRef(false);
  // Release the submit lock once any render commits — every dispatch path
  // triggers state updates (cleared input / slot patch), so after commit the
  // fresh closures' own guards (`streaming`, empty input) are in force.
  useEffect(() => {
    submitLockRef.current = false;
  });
  // Dedicated picker for request_local_file (kept separate from fileInputRef so
  // the pick routes to the SW round-trip, not the normal attach flow).
  const localFileRequestInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // InstanceSelector state — list of configured instances + per-session current
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [currentInstanceId, setCurrentInstanceId] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  // Helper to persist the (instanceId, model) selection to session meta
  async function persistSelection(sessionId: string, id: string, model: string) {
    const existing = await getSessionMeta(sessionId);
    if (!existing) return;
    await setSessionMeta({ ...existing, instanceId: id, model });
  }

  // Load instances list + current session's instanceId on mount / sessionId change
  const sessionId = session.sessionId;
  const { pending: cdpPending, answer: answerCdp } = useCdpOnboarding(session.port, sessionId);
  const { pending: localFilePending, respond: respondLocalFile } = useLocalFileRequest(
    session.port,
    sessionId,
  );
  const { showCard: showFileAccess, dismiss: dismissFileAccess } = useFileAccessPrompt(
    session.port,
  );
  useEffect(() => {
    listInstances().then(setInstances).catch(() => setInstances([]));
    if (!sessionId) return;

    // Effective id = per-session pin fallback to global active.
    // sessionId is narrowed to string by the early return above; the async
    // closure captures the narrowed binding but TypeScript doesn't propagate
    // that narrowing into nested async functions — capture it explicitly.
    const sessionIdStr = sessionId as string;
    async function loadEffective() {
      const meta = await getSessionMeta(sessionIdStr);
      const sel = await resolveSelection({ instanceId: meta?.instanceId, model: meta?.model });
      setCurrentInstanceId(sel?.instanceId ?? null);
      setCurrentModel(sel?.model ?? null);
    }
    loadEffective().catch(() => { setCurrentInstanceId(null); setCurrentModel(null); });
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-resolve the effective selection when the per-session model pin
  // (session meta → "sessions"), the global last_model_selection /
  // active_instance_id ("config"), or instance config ("instances") changes.
  // store-bus events are coarse, so we always re-run the full resolve.
  const reloadEffectiveSelection = () => {
    if (!sessionId) return;
    const sessionIdStr = sessionId;
    void (async () => {
      const meta = await getSessionMeta(sessionIdStr);
      const sel = await resolveSelection({ instanceId: meta?.instanceId, model: meta?.model });
      setCurrentInstanceId(sel?.instanceId ?? null);
      setCurrentModel(sel?.model ?? null);
    })().catch(() => {});
  };
  useStoreChange("sessions", reloadEffectiveSelection);
  useStoreChange("config", reloadEffectiveSelection);
  useStoreChange("instances", reloadEffectiveSelection);

  useEffect(() => {
    checkConfig();
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // hasConfig depends on the resolved selection + instance config: former keys
  // last_model_selection / instances_index / active_instance_id ("config"),
  // session meta pin ("sessions"), and instance_* records ("instances").
  useStoreChange("config", () => checkConfig());
  useStoreChange("sessions", () => checkConfig());
  useStoreChange("instances", () => checkConfig());

  // R9 sub-path b — clear pending image attachments when the user switches
  // to a provider that lacks vision support. The dependency array intentionally
  // contains only supportsVision so this fires on the flip (false→true and
  // true→false) rather than on every attachments change, which would cause
  // infinite re-render loops. The initial render value is false (default), so
  // we guard against clearing on mount by checking attachments.length.
  useEffect(() => {
    if (!supportsVision && attachments.length > 0) {
      showLocalToast(t("chat.attachment.visionProviderCleared"));
      setAttachments([]);
    }
  }, [supportsVision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear the toast timer on unmount to prevent state-update-on-dead-component.
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    getEnabledSkillPackages()
      .then(setEnabledSkills)
      .catch(() => setEnabledSkills([]));
  }, []);

  // The enabled-skills toggle (`enabled_skills`) now lives in the IDB `config`
  // store. NOTE: skill *package* definitions live in a separate `pie-skills`
  // IDB that does NOT emit store-bus events, so edits to a package's contents
  // won't trigger this reload — only enable/disable toggles do. (Known gap;
  // matches the migration scope.)
  useStoreChange("config", (c) => {
    if (c.id && c.id !== "enabled_skills") return;
    getEnabledSkillPackages()
      .then(setEnabledSkills)
      .catch(() => setEnabledSkills([]));
  });

  useEffect(() => {
    if (!atBottomRef.current) return;
    const c = scrollContainerRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, [messages, streamingText]);

  const handleMessagesScroll = () => {
    const c = scrollContainerRef.current;
    if (!c) return;
    atBottomRef.current = c.scrollHeight - c.scrollTop - c.clientHeight <= 60;
  };

  // Mount the pin dropdown as soon as it opens; unmounting waits for the
  // dropdown's leave animation (onExited).
  useEffect(() => {
    if (pinDropdownOpen) setPinDropdownVisible(true);
  }, [pinDropdownOpen]);

  useEffect(() => {
    if (prefillInput) {
      setInput(prefillInput);
      if (prefillInput.startsWith("/")) {
        setDismissedInput(prefillInput);
      }
      onPrefillConsumed?.();
    }
  }, [prefillInput]); // eslint-disable-line react-hooks/exhaustive-deps

  // PINNED display contract (M3-U2 post-acceptance, per user feedback):
  //   - empty session AND not streaming  → live preview of current active
  //     tab. User can freely tab-switch; PINNED follows. The session is
  //     not locked yet — first sendMessage will capture and persist.
  //   - non-empty session OR streaming   → frozen to the persisted pin
  //     (sessionPinnedOrigin from session meta). Tab-switching in this
  //     state is irrelevant: the agent will operate on the locked tab.
  //
  // Why messages.length > 0 (not just streaming): between tasks (after
  // chat-done / agent-done-task / paused) `streaming` is false but the
  // session still has content. The earlier "lock only during streaming"
  // rule let PINNED drift between tasks, which surprised users who
  // expected the pin to stay put for the whole conversation. The new
  // rule mirrors the underlying persistence: pin is captured once at
  // first send and stays until the session is cleared.
  // M5 — isLocked is now driven by pinMode, not messages.length:
  //   - 'auto' (default for empty + post-task sessions): UI live-tracks
  //     the user's currently-active tab; PINNED row updates dynamically
  //   - 'task' (in-flight): pin frozen to send-time active tab
  //   - 'user' (user-locked): pin frozen to user's dropdown choice
  // Streaming forces locked regardless of mode (defensive — there's
  // always a task pin while streaming, and we don't want the UI to
  // re-render mid-task as the user tab-switches).
  const isLocked = streaming || (pinMode !== null && pinMode !== "auto");

  useEffect(() => {
    if (isLocked) {
      // No live tracking when locked — the displayed pin comes from
      // sessionPinnedOrigin (session meta) and storage onChanged keeps
      // it fresh. Skip the chrome.tabs listeners entirely so they don't
      // burn cycles in the locked state.
      return;
    }
    async function refreshLive() {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        setLivePinnedOrigin(tab?.url ? extractOrigin(tab.url) : null);
        setLivePinnedTitle(tab?.title ? tab.title : null);
      } catch {
        // non-fatal — keep prior value
      }
    }

    void refreshLive();

    const onActivated = () => {
      void refreshLive();
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      // Refresh on any url OR title change of the active tab. Title alone
      // (no url change) covers SPAs that update document.title after load
      // and same-origin route changes that just rename the tab.
      if (tab.active && (changeInfo.url || changeInfo.title)) {
        void refreshLive();
      }
    };
    const onFocusChanged = (winId: number) => {
      // chrome.windows.WINDOW_ID_NONE === -1 fires when chrome loses focus
      // entirely; ignore to avoid clearing pin on app-switch.
      if (winId === chrome.windows.WINDOW_ID_NONE) return;
      void refreshLive();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    };
  }, [isLocked]);

  // v1.5 — Set of ALL pinned tab IDs for the pageChanged effect filter.
  const pinnedTabIds = useMemo(
    () => new Set((pinnedTabs ?? []).map((p) => p.tabId)),
    [pinnedTabs],
  );

  // M5 — pageChanged banner only cares about navigation on the SPECIFIC
  // pinned tab(s), and only during a 'task'-mode in-flight task.
  //
  // Old behavior (pre-M5 bug): watched ANY tab.active+changeInfo.url, which
  // false-positived whenever the user switched to a different tab — that
  // tab's url change (already-loaded page → "active" event includes a URL)
  // would trigger the banner even though the pinned tab itself was idle.
  //
  // New invariants:
  //   - 'task' only — 'user' mode pins are fixed by user intent (origin
  //     change is the user's call, no warning). 'auto' has no pin.
  //   - v1.5: filter chrome.tabs.onUpdated by pinnedTabIds set — only
  //     navigation on any pinned tab flags page-changed.
  useEffect(() => {
    if (pinMode !== "task") return;
    if (pinnedTabIds.size === 0) return;
    const onUpdated = (
      tabId: number,
      info: chrome.tabs.OnUpdatedInfo,
      _tab: chrome.tabs.Tab,
    ) => {
      // Only fire for an actual pinned tab navigating — not any other tab,
      // not even when the user switches to a different active tab.
      if (!pinnedTabIds.has(tabId)) return;
      if (info.url) {
        setPageChanged(true);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onUpdated);
  }, [pinMode, pinnedTabIds]);

  // M5 follow-up — locked-mode title fetcher. Reads the pinned tab's
  // current title via chrome.tabs.get; refreshes whenever the pinned tab
  // updates its title (SPAs change document.title async on route change).
  // Falls back to null on closed/inaccessible tab — display layer handles
  // host-fallback in that case.
  useEffect(() => {
    if (!isLocked) {
      setLockedPinnedTitle(null);
      return;
    }
    if (sessionPinnedTabId === null) {
      setLockedPinnedTitle(null);
      return;
    }
    const targetTabId = sessionPinnedTabId;
    let cancelled = false;
    async function fetchTitle() {
      try {
        const tab = await chrome.tabs.get(targetTabId);
        if (cancelled) return;
        setLockedPinnedTitle(tab.title ?? null);
      } catch {
        if (cancelled) return;
        setLockedPinnedTitle(null);
      }
    }
    void fetchTitle();
    const onUpdated = (
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (tabId !== targetTabId) return;
      if (changeInfo.title || changeInfo.url) {
        setLockedPinnedTitle(tab.title ?? null);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      cancelled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [isLocked, sessionPinnedTabId]);

  // Display label — prefer tab title for human readability; fall back to
  // host (extracted from origin) when title is unavailable. Locked vs
  // free state pick from different sources but same fallback chain.
  const PIN_LABEL_MAX_LEN = 60;
  function truncate(s: string): string {
    return s.length > PIN_LABEL_MAX_LEN ? s.slice(0, PIN_LABEL_MAX_LEN - 1) + "…" : s;
  }
  const displayPinnedOrigin = (() => {
    if (isLocked) {
      if (lockedPinnedTitle) return truncate(lockedPinnedTitle);
      if (sessionPinnedOrigin)
        return extractHost(sessionPinnedOrigin) ?? sessionPinnedOrigin;
      return null;
    }
    if (livePinnedTitle) return truncate(livePinnedTitle);
    if (livePinnedOrigin) return extractHost(livePinnedOrigin) ?? livePinnedOrigin;
    return null;
  })();

  async function checkConfig() {
    try {
      const all = await listInstances();
      if (all.length === 0) {
        setHasConfig(false);
        setSupportsVision(false);
        setMaxContextTokens(undefined);
        return;
      }
      setHasConfig(true);
      // Vision support is per-(instance, model), resolved from the current
      // selection (session pin → last_model_selection → first instance).
      const cfgMeta = sessionId ? await getSessionMeta(sessionId) : null;
      const sel = await resolveSelection({ instanceId: cfgMeta?.instanceId, model: cfgMeta?.model });
      if (sel) {
        const inst = await getInstance(sel.instanceId);
        if (inst) {
          // Vision lookup consults registry first, then instance.fetchedModels
          // (OpenRouter lazy catalog). Fail-closed for unknown ids — the disabled
          // attach button is a visible UX cue (a different policy from the loop's
          // screenshot guard, which fail-opens).
          setSupportsVision(await resolveSupportsVision(inst.provider, sel.model, inst.fetchedModels));
          const mm = await resolveModelMeta(inst.provider, sel.model);
          setMaxContextTokens(mm?.maxContextTokens);
          return;
        }
      }
      setSupportsVision(false);
      setMaxContextTokens(undefined);
    } catch {
      setHasConfig(false);
      setSupportsVision(false);
      setMaxContextTokens(undefined);
    }
  }

  // Phase 5 — local transient warning for image upload errors.
  // Uses inline render below (same visual style as the error banner) rather
  // than the session toast (that surface is SW→panel wire only, read-only here).
  function showLocalToast(msg: string) {
    setAttachLocalToast(msg);
    // Clear any prior pending dismiss before scheduling a fresh one.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setAttachLocalToast(null), 4000);
  }

  const addPickedFiles = async (files: File[]) => {
    if (files.length === 0) {
      // Composer detected image data in the paste/drop event but no File
      // object was extractable (e.g. user copied an <img> from a web page —
      // clipboard carries text/uri-list / text/html, not a binary File).
      // User has to save the image to disk first and use the file picker.
      showLocalToast(
        t("chat.attachment.clipboardUnsupported"),
      );
      return;
    }
    for (const f of files) {
      // For image files, use the per-image resize spinner UX.
      // processPickedFile handles image resizing internally, but we track
      // the spinner for images so the user sees feedback during resize.
      const isImage = f.type.startsWith("image/");
      let tempId: string | null = null;
      if (isImage) {
        // Check image cap before starting spinner
        if (attachments.length >= MAX_IMAGES_PER_TURN) {
          showLocalToast(t("chat.attachment.maxImagesPerMessage", { max: String(MAX_IMAGES_PER_TURN) }));
          continue;
        }
        tempId = `pending_${crypto.randomUUID()}`;
        setResizing((s) => new Set(s).add(tempId!));
      }
      try {
        const result = await processPickedFile(f, { supportsVision });
        if (isImage && tempId) {
          setResizing((s) => {
            const next = new Set(s);
            next.delete(tempId!);
            return next;
          });
        }
        if (!result.ok) {
          // Map reason → localized message. processPickedFile stays
          // i18n-decoupled (returns English dev strings); we localize here.
          // result.message is a dev-only fallback for unmapped reasons.
          let toastMsg: string;
          switch (result.reason) {
            case "no_vision":
              toastMsg = t("chat.attachment.attachImageNoVision");
              break;
            case "too_large":
              toastMsg = t("chat.files.tooLarge", { name: f.name });
              break;
            case "unsupported":
              toastMsg = t("chat.files.unsupported", { name: f.name });
              break;
            case "error":
              toastMsg = t("chat.files.processingFailed");
              break;
            default:
              toastMsg = result.message;
          }
          showLocalToast(toastMsg);
          continue;
        }
        if (result.kind === "image") {
          // Re-check cap after async operation in case another file added one
          setAttachments((prev) => {
            if (prev.length >= MAX_IMAGES_PER_TURN) return prev;
            return [...prev, result.attachment];
          });
        } else {
          // kind === "file" — text/code/PDF
          setFileAttachments((prev) => [...prev, result.attachment]);
        }
      } catch {
        if (isImage && tempId) {
          setResizing((s) => {
            const next = new Set(s);
            next.delete(tempId!);
            return next;
          });
        }
        showLocalToast(t("chat.files.processingFailed"));
      }
    }
  };

  // request_local_file — the user picked a file via the dedicated input. Route
  // the result back to the SW (not the normal attach flow). Text/PDF → ok;
  // images / unsupported / failures → ok:false with a reason.
  const handleLocalFileRequestPick = async (files: File[]) => {
    const f = files[0];
    // Defensive only: a native-dialog Cancel produces NO onChange event, so
    // this branch effectively never fires from the picker. The real Cancel
    // path is the card's Cancel button (onCancel → respondLocalFile).
    if (!f) {
      respondLocalFile({ ok: false, reason: "cancelled by user" });
      return;
    }
    try {
      const result = await processPickedFile(f, { supportsVision });
      if (result.ok && result.kind === "file") {
        const att = result.attachment;
        respondLocalFile({
          ok: true,
          name: att.name,
          mime: att.mime,
          text: att.text,
          truncated: att.truncated,
        });
        return;
      }
      // Non-file outcome: either a processing failure (!ok) with a specific
      // reason, or an image (ok but kind:"image") which can't be returned
      // through this tool result. Mirror the reason-mapping used in
      // addPickedFiles so the toast matches the actual failure.
      if (!result.ok) {
        switch (result.reason) {
          case "too_large": showLocalToast(t("chat.files.tooLarge", { name: f.name })); break;
          case "unsupported": showLocalToast(t("chat.files.unsupported", { name: f.name })); break;
          case "no_vision": showLocalToast(t("chat.attachment.attachImageNoVision")); break;
          default: showLocalToast(t("chat.files.processingFailed"));
        }
      } else {
        // ok:true but kind:"image" — images can't be returned through this tool result
        showLocalToast(t("chat.attachment.attachImageNoVision"));
      }
      respondLocalFile({
        ok: false,
        reason: "image_or_unsupported: that file type can't be returned here; for images use the + menu",
      });
    } catch {
      showLocalToast(t("chat.files.processingFailed"));
      respondLocalFile({ ok: false, reason: "processing failed" });
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  const slashState = useMemo(() => {
    if (!input.startsWith("/")) return null;
    const m = input.match(/^\/(\S*)$/);
    if (!m) return null;
    const query = m[1];
    return { query, results: filterAndSortSkillsForSlash(query, enabledSkills) };
  }, [input, enabledSkills]);

  // Issue #34 — hide user messages that are still pending (rendered in the
  // PendingInstructionList above the Composer instead). When SW drains the
  // queue, the broadcast clears pendingByChatMessageId for that id and the
  // bubble naturally reappears in chat history as a normal user message.
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) => !(m.role === "user" && m.id && pendingByChatMessageId.has(m.id)),
      ),
    [messages, pendingByChatMessageId],
  );

  // Group consecutive agent-step messages into one AgentStepGroup. Declared
  // here, ABOVE all early returns, so hooks order stays stable across renders
  // (React error #310 happened when this was below `if (hasConfig === null)`).
  const segments = useMemo(() => buildSegments(visibleMessages), [visibleMessages]);

  const popoverOpen = slashState !== null && input !== dismissedInput;

  useEffect(() => {
    setPopoverSelected(0);
  }, [slashState?.query]);

  useEffect(() => {
    if (pickerActive && quotes && quotes.some((q) => q.kind === "element")) {
      setPickerActive(false);
    }
  }, [quotes, pickerActive]);

  function pickSlashSkill(skill: SkillPackage) {
    const slug = normalizeSkillSlashKey(skill.frontmatter.name) || skill.id;
    setInput(`/${slug} `);
    setPopoverSelected(0);
    setDismissedInput(null);
  }

  async function sendMessage(text?: string) {
    const userInput = (text ?? input).trim();
    if (streaming || !ready) return;
    // Allow empty userInput when a pendingRecording exists (LLM still gets
    // the full trace + an empty user-prompt).
    if (!userInput && !pendingRecording) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;

    setInput("");
    clearError();
    setAttachLocalToast(null);

    let content = userInput;
    let expandedForLLM: string | undefined = undefined;

    if (pendingRecording) {
      // Reframe (2026-05-05): on Send with pendingRecording, the LLM-facing
      // message is an instruction to invoke create_skill_from_recording with
      // the serialized trace + user's free-text prompt. The user-visible
      // content shows a concise "📼 从录制创建 skill" badge + their prompt.
      const userPromptText = userInput || "(no additional guidance)";
      content = userInput
        ? t("chat.recording.createSkillFromRecording", { input: userInput })
        : t("chat.recording.createSkillFromRecordingWithStep", { stepCount: pendingRecording.stepCount });
      expandedForLLM = `Run the "Create Skill from Recording" skill (id: create_skill_from_recording).

The recording trace and user goal are provided below. Follow the skill's
instructions to distill them into a reusable skill and call create_skill
with { name, description, instructions }.

User goal: ${JSON.stringify(userPromptText)}

<recordingTrace>
${pendingRecording.trace}
</recordingTrace>

After the skill completes, briefly summarize what was created (the user will see a confirm card before the new skill is persisted).`;
      if (onPendingRecordingConsumed) onPendingRecordingConsumed();
    } else if (content.startsWith("/")) {
      try {
        const skills = await getEnabledSkillPackages();
        const match = resolveSlashCommand(content, skills);
        if (match) {
          expandedForLLM = expandSlashCommand(match);
        }
      } catch {
        // resolver failure is non-fatal
      }
    }

    // Capture attachments snapshot before clearing
    const pendingAttachments = attachments.length > 0 ? [...attachments] : undefined;
    setAttachments([]);
    const pendingFileAttachments = fileAttachments.length > 0 ? [...fileAttachments] : undefined;
    setFileAttachments([]);

    // Issue #38 v1 — serialize quotes into the LLM-facing wire content and
    // element-quote screenshots into attachments. The display layer reads the
    // structured `quotes` array (preserved below) instead of re-parsing wrappers.
    const quoteImages: ImageAttachment[] = [];
    const quoteParts: string[] = [];
    if (quotes) {
      for (const q of quotes) {
        if (q.kind === "text") {
          quoteParts.push(
            `<untrusted_page_quote source_url="${escapeWrapperAttribute(q.sourceUrl)}">\n${q.text}\n</untrusted_page_quote>`,
          );
        } else {
          quoteParts.push(
            `<untrusted_page_element source_url="${escapeWrapperAttribute(q.sourceUrl)}" role="${escapeWrapperAttribute(q.role)}" name="${escapeWrapperAttribute(q.accessibleName)}">\ntext_content: ${JSON.stringify(q.textContent)}\nouter_html: ${JSON.stringify(q.outerHTMLTruncated)}\n</untrusted_page_element>`,
          );
          if (q.imageDataUrl) {
            const [meta, b64] = q.imageDataUrl.split(",");
            const mediaType = (meta.match(/data:([^;]+)/)?.[1] ?? "image/jpeg") as "image/jpeg" | "image/png";
            // width/height unknown for quote element screenshots; byteLength approximated
            // from base64 length. These fields are required by ImageAttachment but are
            // not used for quote images (they are LLM-context-only, not thumbnail-displayed).
            quoteImages.push({ kind: "image" as const, id: `quote-${q.id}`, data: b64, mediaType, width: 0, height: 0, byteLength: Math.ceil((b64.length * 3) / 4) });
          }
        }
      }
    }
    const allAttachments = [...(pendingAttachments ?? []), ...quoteImages];

    // Wire content = quote wrappers + (slash-expanded ?? typed). When quotes
    // present, lift the user-facing `content` into expandedForLLM so the LLM
    // sees the wrappers while the chat bubble still renders just the typed text.
    if (quoteParts.length > 0) {
      const quoteText = quoteParts.join("\n\n");
      const wireText = expandedForLLM ?? content;
      expandedForLLM = wireText ? `${quoteText}\n\n${wireText}` : quoteText;
    }

    // Append file attachment wrappers to the LLM-facing content (same pattern
    // as quote wrappers above — joined into expandedForLLM, not visible content).
    if (pendingFileAttachments && pendingFileAttachments.length > 0) {
      const fileParts = pendingFileAttachments.map(fileAttachmentToWrapper).join("\n\n");
      const wireText = expandedForLLM ?? content;
      expandedForLLM = wireText ? `${wireText}\n\n${fileParts}` : fileParts;
    }

    const stagedQuotes = quotes && quotes.length > 0 ? [...quotes] : undefined;

    sessionSendMessage({
      content,
      expandedForLLM,
      attachments: allAttachments.length > 0 ? allAttachments : undefined,
      quotes: stagedQuotes,
      fileAttachments: pendingFileAttachments,
    });

    // Clear quotes after send
    if (quotes && quotes.length > 0 && sessionId) {
      clearQuotes(sessionId);
    }
  }

  // Issue #34 — textarea enabled only when the session is active (not paused/failed/archived).
  // Replaces the old `disabled={streaming}` guard which kept the field locked
  // between tasks even when the agent was idle.
  const sessionAllowsInput = status === "active";

  // Issue #34 — pending instruction items derived from messages + pendingByChatMessageId.
  const pendingItems = messages.flatMap((m) => {
    if (m.role !== "user" || !m.id) return [];
    if (!pendingByChatMessageId.has(m.id)) return [];
    return [{ chatMessageId: m.id, content: m.content }];
  });

  // Issue #34 — unified submit: queue during streaming, send otherwise.
  // Keeps all slash-expansion / pendingRecording / quote logic in the existing
  // sendMessage() function so it only runs on the non-streaming path.
  function handleSubmit() {
    if (streaming) {
      const userInput = input.trim();
      if (!userInput) return;
      if (submitLockRef.current) return;
      submitLockRef.current = true;

      // Build simple payload — slash expansion is not meaningful during
      // streaming (the active task already has its expanded prompt).
      const pendingAttachments = attachments.length > 0 ? [...attachments] : undefined;
      setAttachments([]);
      const pendingFileAttachments = fileAttachments.length > 0 ? [...fileAttachments] : undefined;
      setFileAttachments([]);

      const quoteImages: ImageAttachment[] = [];
      const quoteParts: string[] = [];
      if (quotes) {
        for (const q of quotes) {
          if (q.kind === "text") {
            quoteParts.push(
              `<untrusted_page_quote source_url="${escapeWrapperAttribute(q.sourceUrl)}">\n${q.text}\n</untrusted_page_quote>`,
            );
          } else {
            quoteParts.push(
              `<untrusted_page_element source_url="${escapeWrapperAttribute(q.sourceUrl)}" role="${escapeWrapperAttribute(q.role)}" name="${escapeWrapperAttribute(q.accessibleName)}">\ntext_content: ${JSON.stringify(q.textContent)}\nouter_html: ${JSON.stringify(q.outerHTMLTruncated)}\n</untrusted_page_element>`,
            );
            if (q.imageDataUrl) {
              const [meta, b64] = q.imageDataUrl.split(",");
              const mediaType = (meta.match(/data:([^;]+)/)?.[1] ?? "image/jpeg") as "image/jpeg" | "image/png";
              // width/height unknown for quote element screenshots; byteLength approximated
              // from base64 length. These fields are required by ImageAttachment but are
              // not used for quote images (they are LLM-context-only, not thumbnail-displayed).
              quoteImages.push({ kind: "image" as const, id: `quote-${q.id}`, data: b64, mediaType, width: 0, height: 0, byteLength: Math.ceil((b64.length * 3) / 4) });
            }
          }
        }
      }
      const allAttachments = [...(pendingAttachments ?? []), ...quoteImages];

      let expandedForLLM: string | undefined = undefined;
      if (quoteParts.length > 0) {
        const quoteText = quoteParts.join("\n\n");
        expandedForLLM = quoteText ? `${quoteText}\n\n${userInput}` : userInput;
      }

      // Append file attachment wrappers (mirrors the sendMessage path above).
      if (pendingFileAttachments && pendingFileAttachments.length > 0) {
        const fileParts = pendingFileAttachments.map(fileAttachmentToWrapper).join("\n\n");
        const wireText = expandedForLLM ?? userInput;
        expandedForLLM = wireText ? `${wireText}\n\n${fileParts}` : fileParts;
      }

      const stagedQuotes = quotes && quotes.length > 0 ? [...quotes] : undefined;

      addPendingInstruction({
        content: userInput,
        expandedForLLM,
        attachments: allAttachments.length > 0 ? allAttachments : undefined,
        quotes: stagedQuotes,
        fileAttachments: pendingFileAttachments,
      });

      setInput("");
      if (quotes && quotes.length > 0 && sessionId) {
        clearQuotes(sessionId);
      }
    } else {
      void sendMessage();
    }
  }

  async function onPickElement() {
    const tab = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab[0]?.id;
    if (typeof tabId !== "number" || !port) return;
    if (!pickerActive) {
      port.postMessage({ type: "picker:start", tabId });
      setPickerActive(true);
    } else {
      port.postMessage({ type: "picker:stop", tabId });
      setPickerActive(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // IME composition — Enter/arrow keys during composition belong to the
    // IME candidate window, not the composer (Chrome delivers the commit
    // Enter with isComposing=true; Safari fires it after compositionend
    // with keyCode 229). Treating them as submit would send a truncated
    // message and break the composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (popoverOpen && slashState && slashState.results.length > 0) {
      const list = slashState.results;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPopoverSelected((i) => Math.min(i + 1, list.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPopoverSelected((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const picked = list[popoverSelected];
        if (picked) pickSlashSkill(picked);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const picked = list[popoverSelected];
        if (picked) pickSlashSkill(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedInput(input);
        return;
      }
    }
    if (popoverOpen && e.key === "Escape") {
      e.preventDefault();
      setDismissedInput(input);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleStop() {
    abort();
  }

  function handleNewTask() {
    void clearMessages();
    setPageChanged(false);
  }

  if (hasConfig === false) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-fg-2">
          <span className="caps text-fg-3">{t("chat.noApiKey")}</span>
          <p className="text-center text-[13px] leading-5">
            {t("chat.noApiKeyDescription")}
          </p>
          <button
            onClick={onOpenSettings}
            className="rounded-md bg-fg-1 px-4 py-2 text-[13px] font-medium text-canvas hover:opacity-90"
          >
            {t("chat.openSettings")}
          </button>
        </div>
      </div>
    );
  }

  if (hasConfig === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center text-fg-3">
          <span className="caps">{t("chat.loading")}</span>
        </div>
      </div>
    );
  }

  const stepCount = messages.filter((m) => m.role === "agent-step").length;

  return (
    <div className="flex h-full flex-col">
      {/* Pinned origin + step counter info bar.
       *  M5 follow-up: provider/model label removed — was getting squeezed by
       *  the new PinnedTabDropdown button. Provider info still visible in
       *  Settings; users typically switch there, not from the chat header. */}
      {(displayPinnedOrigin || (streaming && stepCount > 0)) && (
        <div className="relative flex flex-shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 py-1.5">
          {displayPinnedOrigin && (
            <>
              <button
                ref={pinAnchorRef}
                type="button"
                onClick={() => setPinDropdownOpen((v) => !v)}
                aria-label={t("chat.pinnedTabSelector")}
                aria-expanded={pinDropdownOpen}
                className="flex flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-field"
              >
                <span className="caps text-fg-3">
                  {pinMode === "user" ? t("chat.pinnedStar") : isLocked ? t("chat.pinned") : t("chat.pin")}
                </span>
                <span className="flex-1 truncate font-mono text-[11px] text-fg-2">
                  {displayPinnedOrigin}
                </span>
                {pinnedTabs && pinnedTabs.length > 1 ? (
                  <span className="ml-1 rounded bg-accent-tint px-1 text-[10px] text-accent">
                    ×{pinnedTabs.length}
                  </span>
                ) : null}
                <span className="text-fg-3 text-[10px]" aria-hidden="true">▾</span>
              </button>
              {pinDropdownVisible && (
                <PinnedTabDropdown
                  open={pinDropdownOpen}
                  anchorRef={pinAnchorRef}
                  pinMode={pinMode}
                  pinnedTabs={pinnedTabs}
                  streaming={streaming}
                  onToggle={(tabId, origin) => {
                    void togglePinTab(tabId, origin);
                  }}
                  onClearPin={() => {
                    void clearUserPin();
                  }}
                  onClose={() => setPinDropdownOpen(false)}
                  onExited={() => setPinDropdownVisible(false)}
                />
              )}
            </>
          )}
          {!displayPinnedOrigin && <div className="flex-1" />}
          {streaming && stepCount > 0 && (
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-accent tabular">
              {t("chat.stepCount.one")} {String(stepCount).padStart(2, "0")}
            </span>
          )}
        </div>
      )}

      {/* M1-U5 — paused-task affordance. Sticky bar appears whenever
          the SW has marked this session paused (cold-start detected an
          in-flight task that died with the SW). Click → Resume; SW
          either restarts the loop or shows the drift card. */}
      {session.status === "paused" && (
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-warning-line bg-warning-tint px-4 py-2 text-[12px]">
          <div className="flex flex-col gap-0.5">
            <span className="caps text-warning">{t("chat.paused")}</span>
            <span className="text-fg-1">
              {t("chat.pausedDescription")}
            </span>
          </div>
          <button
            onClick={() => session.resumeTask()}
            className="rounded border border-warning-line bg-transparent px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-warning hover:bg-warning-tint/60"
            aria-label={t("chat.resumeTaskAria")}
          >
            {t("chat.resumeTask")}
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={handleMessagesScroll}
        className="flex-1 overflow-y-auto"
      >
        {messages.length === 0 && !streaming && !pageChanged ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-[18px] px-4 py-5">
            {pageChanged && (
              <PageChangedBanner onNewTask={handleNewTask} />
            )}

            {segments.map((seg) => {
              // M5 motion: bubble-in for content rows, scale-in for
              // session-confirm cards. Wrappers carry the animation class
              // so message components stay layout-agnostic.
              // For agent-step groups, the wrapper plays bubble-in once on
              // group mount; subsequent in-place updates of the active step
              // don't replay because React reuses the same DOM nodes.
              if (seg.kind === "steps") {
                return (
                  <div key={`steps-${seg.firstIndex}`} className="bubble-in">
                    <AgentStepGroup
                      doneSteps={seg.doneSteps}
                      currentStep={seg.currentStep}
                    />
                  </div>
                );
              }
              const { msg, firstIndex } = seg;
              if (msg.role === "user" || msg.role === "assistant") {
                return (
                  <div key={firstIndex} className="bubble-in">
                    <MessageBubble message={msg} />
                  </div>
                );
              }
              if (msg.role === "agent-summary") {
                return (
                  <div key={firstIndex} className="bubble-in">
                    <AgentSummary
                      success={msg.success}
                      summary={msg.summary}
                      stepCount={msg.stepCount}
                    />
                  </div>
                );
              }
              if (msg.role === "session-confirm") {
                return (
                  <div key={firstIndex} className="scale-in">
                    <SessionConfirmCard
                      kind={msg.kind}
                      payload={msg.payload}
                      resolved={msg.resolved}
                      onDiscard={() => session.discardTask(msg.confirmationId)}
                    />
                  </div>
                );
              }
              if (msg.role === "file-output") {
                // Key by artifactId (not the numeric index) so React never
                // reuses a card instance across sessions/artifacts — index keys
                // let a previous session's card (and its local expired state)
                // get reused at the same position when switching sessions.
                return (
                  <div key={`fileout-${msg.artifactId}`} className="bubble-in">
                    <FileOutputCard
                      artifactId={msg.artifactId}
                      filename={msg.filename}
                      mime={msg.mime}
                      size={msg.size}
                      onDownload={session.downloadOutput}
                      onProbe={artifactExists}
                    />
                  </div>
                );
              }
              return null;
            })}

            {streaming && (streamingText || streamingThinking) && (
              <MessageBubble
                message={{ role: "assistant", content: streamingText, thinking: streamingThinking }}
                thinkingStreaming={!!streamingThinking}
              />
            )}

            {/* Working indicator — visible whenever the agent loop is alive,
                INCLUDING while a long tool call's arguments stream (e.g.
                output_file's file content): no text deltas arrive during that
                window, so a static preamble bubble alone would look frozen.
                Sits at the tail so there's a single place to confirm "still
                working" — also covers the gaps between tool calls. */}
            {streaming && <WorkingIndicator />}

            {error && (
              <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">
                {error}
              </div>
            )}

            {/* SEC-PLAN-009 — transient toast from SW (flood-limit warning, etc.) */}
            {toast && (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning flex items-start gap-2"
              >
                <span style={{ flex: 1 }}>{toast.text}</span>
                <button
                  type="button"
                  onClick={clearToast}
                  aria-label={t("chat.dismissNotification")}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "inherit",
                    padding: 0,
                    fontSize: 12,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Phase 5 — hidden file input, wired to fileInputRef */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,text/*,.md,.markdown,.json,.jsonl,.csv,.tsv,.log,.xml,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.sh,.toml,.ini,.sql"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void addPickedFiles([...e.target.files]);
          e.target.value = "";
        }}
      />

      {/* request_local_file — dedicated hidden input; pick routes to the SW
          round-trip via handleLocalFileRequestPick, not the normal attach flow. */}
      <input
        ref={localFileRequestInputRef}
        type="file"
        accept="application/pdf,text/*,.md,.markdown,.json,.jsonl,.csv,.tsv,.log,.xml,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.sh,.toml,.ini,.sql"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void handleLocalFileRequestPick([...e.target.files]);
          e.target.value = "";
        }}
      />

      {/* Phase 5 — local attach error toast (provider no vision / cap exceeded / resize fail) */}
      {attachLocalToast && (
        <div
          role="alert"
          aria-live="polite"
          className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning"
        >
          <span style={{ flex: 1 }}>{attachLocalToast}</span>
          <button
            type="button"
            onClick={() => setAttachLocalToast(null)}
            aria-label={t("common.dismiss")}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              padding: 0,
              fontSize: 12,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Issue #38 v1 — quote chips row */}
      {quotes && quotes.length > 0 && (
        <div aria-label={t("chat.pageContentReferences")} className="flex gap-2 px-4 pb-2 flex-wrap">
          {quotes.map((q) => (
            <QuoteChip
              key={q.id}
              quote={q}
              onRemove={(id) => sessionId && removeQuote(sessionId, id)}
            />
          ))}
        </div>
      )}

      {/* File attachments chip row (text/code/PDF) */}
      {fileAttachments.length > 0 && (
        <div className="flex gap-2 px-4 pb-2 flex-wrap" aria-label={t("chat.files.fileAttachments")}>
          {fileAttachments.map((f) => (
            <FileChip key={f.id} attachment={f} onRemove={(id) => setFileAttachments((p) => p.filter((x) => x.id !== id))} />
          ))}
        </div>
      )}

      {/* Phase 5 — thumbnail row: pending spinners + ready thumbnails */}
      {(attachments.length > 0 || resizing.size > 0) && (
        <div
          role="list"
          aria-label={t("chat.attachment.imageAttachments")}
          className="flex gap-2 px-4 pb-2"
        >
          {[...resizing].map((id) => (
            <div
              key={id}
              role="listitem"
              style={{
                width: 64,
                height: 64,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--c-field)",
                border: "1px solid var(--c-line)",
                borderRadius: 4,
                flexShrink: 0,
              }}
            >
              <span aria-label={t("chat.attachment.processingImage")} style={{ color: "var(--c-fg-3)", fontSize: 18 }}>
                …
              </span>
            </div>
          ))}
          {attachments.map((a) => (
            <div
              key={a.id}
              role="listitem"
              tabIndex={0}
              style={{ position: "relative", width: 64, height: 64, flexShrink: 0 }}
              onKeyDown={(e) => {
                if (e.key === "Backspace" || e.key === "Delete") {
                  e.preventDefault();
                  removeAttachment(a.id);
                }
              }}
            >
              <img
                src={`data:${a.mediaType};base64,${a.data}`}
                alt={t("chat.attachment.uploadedImagePreview")}
                width={64}
                height={64}
                style={{
                  borderRadius: 4,
                  objectFit: "cover",
                  width: 64,
                  height: 64,
                  display: "block",
                  border: "1px solid var(--c-line)",
                }}
              />
              <button
                type="button"
                aria-label={t("chat.attachment.removeImage")}
                onClick={() => removeAttachment(a.id)}
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "var(--c-canvas)",
                  color: "var(--c-fg-1)",
                  border: "1px solid var(--c-line)",
                  fontSize: 12,
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Recording v1 (Reframe 2026-05-05) — pendingRecording chip above
          the composer. × dismisses; Send consumes via expandedForLLM. */}
      {pendingRecording && (
        <div
          data-testid="pending-recording-chip"
          className="mx-3 mb-1.5 flex items-center gap-2 rounded-md border border-line bg-field px-2.5 py-1.5 text-[13px] text-fg-1"
          title={`${t("chat.recording.sendHint")}\n${pendingRecording.trace.slice(0, 200)}${pendingRecording.trace.length > 200 ? "…" : ""}`}
        >
          <span
            className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-pending"
            aria-hidden="true"
          />
          <span className="font-mono text-[10px] font-semibold tracking-[0.08em] text-pending">
            {t("chat.rec")}
          </span>
          <span className="text-fg-1">
            {pendingRecording.stepCount}
            <span className="ml-1 text-fg-3">{pendingRecording.stepCount === 1 ? t("chat.stepCount.one") : t("chat.stepCount.other")}</span>
          </span>
          <span className="text-fg-3">·</span>
          <span className="text-fg-2">{t("chat.recording.composeHint")}</span>
          <button
            type="button"
            aria-label={t("chat.recording.discardRecording")}
            data-testid="dismiss-pending-recording"
            onClick={() => onPendingRecordingConsumed?.()}
            className="ml-auto flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            ×
          </button>
        </div>
      )}

      {cdpPending && <CdpOnboardingCard onAnswer={answerCdp} />}
      {localFilePending && (
        <LocalFileRequestCard
          onChoose={() => localFileRequestInputRef.current?.click()}
          onCancel={() => respondLocalFile({ ok: false, reason: "cancelled by user" })}
        />
      )}
      {showFileAccess && (
        <FileAccessCard onDismiss={dismissFileAccess} />
      )}

      <Composer
        input={input}
        streaming={streaming}
        sessionAllowsInput={sessionAllowsInput}
        popoverOpen={popoverOpen}
        slashState={slashState}
        popoverSelected={popoverSelected}
        supportsVision={supportsVision}
        attachmentCount={attachments.length}
        onChange={(v) => {
          setInput(v);
          if (dismissedInput !== null && v !== dismissedInput) {
            setDismissedInput(null);
          }
        }}
        onSelectPopover={setPopoverSelected}
        onPickSkill={pickSlashSkill}
        onKeyDown={handleKeyDown}
        onSubmit={handleSubmit}
        onStop={handleStop}
        onAttachClick={() => fileInputRef.current?.click()}
        onPickElement={onPickElement}
        pickerActive={pickerActive}
        onPasteFiles={(files) => void addPickedFiles(files)}
        onDropFiles={(files) => void addPickedFiles(files)}
        onStartRecording={onStartRecording}
        recordingDisabled={pendingRecording !== null}
        instances={instances}
        currentInstanceId={currentInstanceId}
        currentModel={currentModel}
        onSelect={async (id, model) => {
          setCurrentInstanceId(id);
          setCurrentModel(model);
          if (sessionId) await persistSelection(sessionId, id, model);
          void setLastModelSelection({ instanceId: id, model });
        }}
        onManageInstances={onOpenSettings}
        onRefreshModels={async (id) => {
          const inst = instances.find((i) => i.id === id);
          if (inst?.provider !== "openrouter") return;
          const orMeta = getProviderMeta("openrouter")!;
          try {
            const fetched = await fetchOpenRouterModels(orMeta.defaultBaseUrl, inst.apiKey || undefined);
            await updateInstance(id, { fetchedModels: fetched, fetchedAt: Date.now() });
            await listInstances().then(setInstances);
          } catch { /* silent; user can retry from Settings */ }
        }}
        usage={usage}
        maxContextTokens={maxContextTokens}
        pendingItems={pendingItems}
        onCancelPending={cancelPendingInstruction}
      />
    </div>
  );
}


function EmptyState() {
  const t = useT();
  const greetingKey = useMemo(() => {
    const keys = [
      "greeting1",
      "greeting2",
      "greeting3",
      "greeting4",
      "greeting5",
      "greeting6",
      "greeting7",
    ] as const;
    return keys[Math.floor(Math.random() * keys.length)];
  }, []);
  const greeting = t(`chat.${greetingKey}`);
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex max-w-[280px] flex-col items-center gap-3">
        <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.015em] text-fg-1">
          {greeting}
        </h1>
        <p className="text-[13px] leading-5 text-fg-2">
          {t("chat.readyDescription")}
        </p>
      </div>
    </div>
  );
}

function PageChangedBanner({ onNewTask }: { onNewTask: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-fg-2">
      <span>{t("chat.pageChangedBanner")}</span>
      <button
        onClick={onNewTask}
        className="rounded border border-line bg-field px-2 py-1 text-fg-1 hover:bg-line"
      >
        {t("chat.newTask")}
      </button>
    </div>
  );
}

function MessageBubble({
  message,
  thinkingStreaming = false,
}: {
  message: Extract<DisplayMessage, { role: "user" | "assistant" }>;
  thinkingStreaming?: boolean;
}) {
  const t = useT();
  if (message.role === "user") {
    // Issue #38 — quote element screenshots ride along in `attachments` so the
    // LLM sees them as image content blocks, but the bubble already renders a
    // 32×20 inline thumbnail per quote; skip the duplicate full-size render.
    const visibleAttachments = message.attachments?.filter(
      (a) => !a.id.startsWith("quote-"),
    );
    const hasQuotes = !!message.quotes && message.quotes.length > 0;
    const hasFileAttachments = !!message.fileAttachments && message.fileAttachments.length > 0;
    const hasText = message.content.length > 0;
    return (
      <div className="flex justify-end">
        <div className="flex min-w-0 max-w-[66%] flex-col gap-2 rounded-[10px_10px_2px_10px] border border-line bg-field px-3.5 py-2.5 text-[13px] leading-5 text-fg-1">
          {hasQuotes && (
            <div className="flex flex-col gap-1.5">
              {message.quotes!.map((q) => (
                <div
                  key={q.id}
                  className="flex items-center gap-2 rounded-lg bg-accent-tint py-1 pl-1 pr-2.5"
                >
                  {q.kind === "text" ? (
                    <span
                      aria-hidden
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent text-canvas"
                    >
                      <QuoteGlyph size={11} />
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-canvas"
                    >
                      {q.imageDataUrl && (
                        <img
                          src={q.imageDataUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      )}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] leading-[18px] text-fg-2">
                    {q.kind === "text" ? (
                      q.text
                    ) : (
                      <>
                        <span className="text-fg-2">{q.role}</span>
                        <span className="text-fg-3"> · </span>
                        <span className="text-fg-1">{`"${q.accessibleName}"`}</span>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {hasFileAttachments && (
            <div className="flex flex-wrap gap-1.5">
              {message.fileAttachments!.map((fa) => (
                <FileChip key={fa.id} attachment={fa} />
              ))}
            </div>
          )}
          {hasText && <CollapsibleText text={message.content} />}
          {visibleAttachments?.map((a) =>
            a.kind === "image" ? (
              <img
                key={a.id}
                src={`data:${a.mediaType};base64,${a.data}`}
                alt={t("chat.attachment.imageAttachment")}
                width={Math.min(160, a.width)}
                className="block rounded"
              />
            ) : (
              // R10/R13 — image bytes not persisted; evicted after SW restart,
              // session switch, or port disconnect. Badge preserved identity so
              // the user understands the image was here but is no longer cached.
              <span
                key={a.id}
                title={t("chat.attachment.imagePlaceholderTitle")}
                className="inline-block self-start rounded border border-line bg-field px-2 py-0.5 font-mono text-[11px] text-fg-3"
              >
                {t("chat.attachment.imageReleasedBadge", { width: a.width, height: a.height })}
              </span>
            ),
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="h-1 w-1 rounded-full bg-accent" />
        <span className="caps text-fg-2">{t("chat.agent")}</span>
      </div>
      {(message.thinking || thinkingStreaming) && (
        <ThinkingSection thinking={message.thinking ?? ""} streaming={thinkingStreaming} />
      )}
      {message.content && (
        <div className="text-[13px] leading-5 text-fg-1">
          <MarkdownContent content={message.content} />
        </div>
      )}
    </div>
  );
}

function WorkingIndicator() {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t("chat.agentWorking")}
      className="flex items-center gap-2 px-1 py-0.5"
    >
      <span className="relative flex h-2 w-2 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-50" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      <span className="caps text-fg-3">{t("chat.working")}</span>
    </div>
  );
}

function Composer({
  input,
  streaming,
  sessionAllowsInput,
  popoverOpen,
  slashState,
  popoverSelected,
  supportsVision,
  attachmentCount,
  onChange,
  onSelectPopover,
  onPickSkill,
  onKeyDown,
  onSubmit,
  onStop,
  onAttachClick,
  onPasteFiles,
  onDropFiles,
  onStartRecording,
  recordingDisabled,
  pickerActive,
  onPickElement,
  instances,
  currentInstanceId,
  currentModel,
  onSelect,
  onManageInstances,
  onRefreshModels,
  usage,
  maxContextTokens,
  pendingItems,
  onCancelPending,
}: {
  input: string;
  streaming: boolean;
  /** Issue #34 — true when the session is active (status === "active").
   *  Textarea is disabled when false (paused/failed/archived). */
  sessionAllowsInput: boolean;
  popoverOpen: boolean;
  slashState: { query: string; results: SkillPackage[] } | null;
  popoverSelected: number;
  supportsVision: boolean;
  attachmentCount: number;
  onChange: (v: string) => void;
  onSelectPopover: (i: number) => void;
  onPickSkill: (skill: SkillPackage) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Issue #34 — unified submit: queues during streaming, sends otherwise. */
  onSubmit: () => void;
  onStop: () => void;
  onAttachClick: () => void;
  onPasteFiles: (files: File[]) => void;
  onDropFiles: (files: File[]) => void;
  /** Recording v1 — when present, render the [● REC] button next to Send.
   *  Click triggers recording-start; the panel switches to RecordingMode
   *  on the next broadcast (no UI feedback inside Composer is needed). */
  onStartRecording?: () => void;
  /** Disabled while a pendingRecording chip is sitting in the input
   *  (you'd send the existing chip first) or when no active session. */
  recordingDisabled?: boolean;
  /** Issue #38 v1 — toggle element picker mode on the page. */
  pickerActive?: boolean;
  onPickElement?: () => void;
  instances: DecryptedInstance[];
  currentInstanceId: string | null;
  currentModel: string | null;
  onSelect: (instanceId: string, model: string) => void;
  onManageInstances: () => void;
  onRefreshModels?: (instanceId: string) => void;
  usage?: import("@/lib/sessions/types").SessionAgentState["contextUsage"];
  maxContextTokens?: number;
  /** Issue #34 — pending instructions queued for the next agent turn. */
  pendingItems: PendingItem[];
  /** Issue #34 — cancel a pending instruction by chatMessageId. */
  onCancelPending: (chatMessageId: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-shrink-0 flex-col gap-2 border-t border-line bg-canvas px-4 pb-4 pt-4">
      {/* Issue #34 — pending instruction list above the input box */}
      {pendingItems.length > 0 && (
        <div className="px-1 pb-2">
          <PendingInstructionList
            items={pendingItems}
            onCancel={onCancelPending}
          />
        </div>
      )}
      <div className="relative">
        {popoverOpen && slashState && (
          <SkillSlashPopover
            skills={slashState.results}
            query={slashState.query}
            selectedIndex={popoverSelected}
            onSelect={onSelectPopover}
            onPick={onPickSkill}
          />
        )}
        {/* Composer box: top-bottom layout */}
        <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-field px-3.5 py-3 focus-within:border-accent-line">
          {/* Top row: textarea full width */}
          <textarea
            value={input}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("chat.composerPlaceholder")}
            rows={3}
            disabled={!sessionAllowsInput}
            className="min-h-[60px] resize-none bg-transparent text-[13px] leading-5 text-fg-1 placeholder:text-fg-3 disabled:opacity-50"
            onPaste={(e) => {
              const dt = e.clipboardData;
              if (!dt) return;
              // Collect EVERY file blob on the clipboard — images copied as
              // image data, plus any text/PDF blob an app exposes. Prefer the
              // standard FileList; fall back to file-kind items (some sources
              // only populate items). addPickedFiles routes by type and
              // rejects unsupported ones via toast.
              // NOTE: macOS Finder "Copy file" usually does NOT surface a File
              // here (browser limitation), so paste mainly covers app-copied
              // blobs; drag-drop (onDrop) is the reliable path for Finder files.
              const files: File[] = [...(dt.files ?? [])];
              if (files.length === 0 && dt.items) {
                for (const item of dt.items) {
                  if (item.kind === "file") {
                    const f = item.getAsFile();
                    if (f) files.push(f);
                  }
                }
              }
              if (files.length > 0) {
                e.preventDefault();
                // Always invoke — addPickedFiles surfaces a toast for every
                // reason (no-vision / cap-exceeded / unsupported / fail).
                onPasteFiles(files);
                return;
              }
              // No file blobs. If an image is present only as a string (e.g. an
              // image URL copied from a web page), it can't be attached —
              // surface the existing guidance toast instead of a silent no-op.
              const hasImageString = Array.from(dt.items ?? []).some((item) =>
                item.type.startsWith("image/"),
              );
              if (hasImageString) {
                e.preventDefault();
                onPasteFiles([]); // empty → clipboardUnsupported guidance toast
                return;
              }
              // Otherwise: normal text paste — fall through (no preventDefault).
            }}
            onDrop={(e) => {
              // Forward ALL dropped File objects — addPickedFiles routes by
              // type and rejects unsupported ones via toast. Supports images,
              // text/code, and PDFs (Task 4.4 unified attach).
              const dropped = [...(e.dataTransfer?.files ?? [])];
              if (dropped.length === 0) return; // no File blobs, leave to default
              e.preventDefault();
              onDropFiles(dropped);
            }}
            onDragOver={(e) => {
              e.preventDefault();
            }}
          />
          {/* Bottom row: action row */}
          <div className="flex items-center gap-2">
            {/* Issue #34 — ToolsMenu (+ button) stays available during streaming
                so users can attach images / pick elements / stage quotes on a
                mid-task instruction before queueing it. Recording is the only
                item that cannot run during streaming and is disabled below. */}
            <ToolsMenu
              onPickElement={onPickElement}
              pickerActive={pickerActive}
              onAttachClick={onAttachClick}
              supportsVision={supportsVision}
              attachmentCount={attachmentCount}
              onStartRecording={onStartRecording}
              recordingDisabled={recordingDisabled || streaming}
            />
            <div className="flex-1" />
            <ModelPicker
              instances={instances}
              currentInstanceId={currentInstanceId}
              currentModel={currentModel}
              locked={streaming}
              onSelect={onSelect}
              onManage={onManageInstances}
              onRefreshModels={onRefreshModels}
            />
            <ContextRing
              lastInputTokens={usage?.lastInputTokens}
              lastOutputTokens={usage?.lastOutputTokens}
              totalInputTokens={usage?.totalInputTokens ?? 0}
              totalOutputTokens={usage?.totalOutputTokens ?? 0}
              maxContextTokens={maxContextTokens}
            />
            {streaming ? (
              <>
                <button
                  type="button"
                  onClick={onStop}
                  aria-label={t("chat.cancelRunningTask")}
                  title={t("chat.cancelRunningTask")}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-fg-1 transition-opacity hover:opacity-70"
                >
                  <svg width="16" height="16" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
                    <path d="M256 256v512h512V256H256z m597.333333-85.333333v682.666666H170.666667V170.666667h682.666666z" />
                  </svg>
                </button>
                {/* Issue #34 — Queue button slides in/out by animating width:
                    keeps the button mounted so width/opacity transitions fire,
                    overflow-hidden clips during the slide, and flex layout
                    pushes the left-side controls as width expands/collapses. */}
                <div
                  className={`flex flex-shrink-0 items-center overflow-hidden transition-all duration-300 ease-out ${
                    input.trim() ? "w-8 opacity-100" : "pointer-events-none w-0 opacity-0"
                  }`}
                  aria-hidden={!input.trim()}
                >
                  <PieSendButton
                    onClick={onSubmit}
                    disabled={!input.trim()}
                    aria-label={t("chat.pending.queue")}
                    title={t("chat.pending.queue")}
                  />
                </div>
              </>
            ) : (
              <PieSendButton onClick={onSubmit} disabled={!input.trim()} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolsMenu({
  onPickElement,
  pickerActive,
  onAttachClick,
  supportsVision,
  attachmentCount,
  onStartRecording,
  recordingDisabled,
}: {
  onPickElement?: () => void;
  pickerActive?: boolean;
  onAttachClick: () => void;
  supportsVision: boolean;
  attachmentCount: number;
  onStartRecording?: () => void;
  recordingDisabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Popover slide-in/out (same pattern as ModelPicker): `mounted` controls
  // render, `shown` the transition target; unmount on exit-transition end.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
  }, [open]);

  // Attach file is always enabled — image-specific limits (no vision / cap exceeded)
  // are handled inside addPickedFiles via toasts; text/PDF always allowed.

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("chat.toolsMenu")}
        aria-expanded={open}
        title={t("chat.toolsMenu")}
        onClick={() => setOpen((v) => !v)}
        className={
          pickerActive
            ? "flex h-7 w-7 items-center justify-center rounded text-accent"
            : "flex h-7 w-7 items-center justify-center rounded text-fg-3 hover:text-fg-1"
        }
      >
        <svg width="16" height="16" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
          <path d="M550.4 550.4v332.8c0 21.207-17.193 38.4-38.4 38.4s-38.4-17.193-38.4-38.4v-332.8h-332.8c-21.207 0-38.4-17.193-38.4-38.4s17.193-38.4 38.4-38.4h332.8v-332.8c0-21.207 17.193-38.4 38.4-38.4s38.4 17.193 38.4 38.4v332.8h332.8c21.207 0 38.4 17.193 38.4 38.4s-17.193 38.4-38.4 38.4h-332.8z" />
        </svg>
      </button>
      {mounted && (
        <div
          onTransitionEnd={() => { if (!shown) setMounted(false); }}
          style={{
            opacity: shown ? 1 : 0,
            transform: shown ? "translateY(0)" : "translateY(8px)",
            transition: "opacity 0.18s ease, transform 0.18s ease",
          }}
          className="absolute bottom-full left-0 z-20 mb-2 w-max whitespace-nowrap overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
        >
          {onPickElement && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onPickElement();
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] hover:bg-field ${pickerActive ? "text-accent" : "text-fg-1"}`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 1024 1024"
                fill="currentColor"
                aria-hidden="true"
                className="flex-shrink-0"
              >
                <path d="M870.4 204.8c-18.6368 0-36.1472 5.0176-51.2 13.7728l0-64.9728c0-56.4736-45.9264-102.4-102.4-102.4-21.0944 0-40.6528 6.4-56.9856 17.3568-14.0288-39.8848-52.0192-68.5568-96.6144-68.5568s-82.6368 28.672-96.6144 68.5568c-16.2816-10.9568-35.8912-17.3568-56.9856-17.3568-56.4736 0-102.4 45.9264-102.4 102.4l0 377.4976-68.9152-119.4496c-13.3632-24.32-35.1744-41.6256-61.3888-48.7936-25.5488-6.9632-52.1216-3.2768-74.8544 10.3424-46.4384 27.8528-64.1536 90.8288-39.424 140.3904 1.536 3.1232 34.2016 70.0416 136.192 273.92 48.0256 96 100.7104 164.6592 156.6208 203.9808 43.8784 30.8736 74.1888 32.4608 79.8208 32.4608l256 0c43.5712 0 84.0704-14.1824 120.4224-42.0864 34.1504-26.2656 63.7952-64.256 88.064-112.8448 47.8208-95.6416 73.1136-227.9424 73.1136-382.6688l0-179.2c0-56.4736-45.9264-102.4-102.4-102.4zM921.6 486.4c0 146.7904-23.3984 271.1552-67.6864 359.7312-28.8768 57.7536-80.5888 126.6688-162.7136 126.6688l-255.488 0c-1.9968-0.1536-23.552-2.56-56.064-26.88-32.4096-24.2688-82.176-75.3664-135.0656-181.248-103.7824-207.5648-135.68-272.9472-135.9872-273.5616-0.0512-0.1024-0.0512-0.1536-0.1024-0.2048-12.8512-25.7536-3.7376-59.4944 19.9168-73.6768 10.6496-6.4 23.0912-8.0896 35.072-4.864 12.7488 3.4816 23.4496 12.0832 30.0544 24.1664 0.1024 0.1536 0.2048 0.3584 0.3072 0.512l79.9232 138.496c16.3328 29.8496 34.7136 42.3936 54.6304 37.3248 19.968-5.0688 30.0544-25.0368 30.0544-59.2384l0-400.0256c0-28.2112 22.9888-51.2 51.2-51.2s51.2 22.9888 51.2 51.2l0 332.8c0 14.1312 11.4688 25.6 25.6 25.6s25.6-11.4688 25.6-25.6l0-384c0-28.2112 22.9888-51.2 51.2-51.2s51.2 22.9888 51.2 51.2l0 384c0 14.1312 11.4688 25.6 25.6 25.6s25.6-11.4688 25.6-25.6l0-332.8c0-28.2112 22.9888-51.2 51.2-51.2s51.2 22.9888 51.2 51.2l0 384c0 14.1312 11.4688 25.6 25.6 25.6s25.6-11.4688 25.6-25.6l0-230.4c0-28.2112 22.9888-51.2 51.2-51.2s51.2 22.9888 51.2 51.2l0 179.2z" />
              </svg>
              <span>{pickerActive ? t("chat.elementPicker.active") : t("chat.elementPicker.idle")}</span>
            </button>
          )}
          <button
            type="button"
            aria-label={t("chat.files.attachFile")}
            onClick={() => {
              setOpen(false);
              onAttachClick();
            }}
            title={t("chat.files.attachFile")}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-fg-1 hover:bg-field disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="flex-shrink-0"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            <span>{t("chat.files.attachFile")}</span>
          </button>
          {onStartRecording && (
            <button
              type="button"
              aria-label={t("chat.startRecording")}
              onClick={() => {
                if (recordingDisabled) return;
                setOpen(false);
                onStartRecording();
              }}
              disabled={recordingDisabled}
              title={t("chat.recordTitle")}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-fg-1 hover:bg-field disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 1024 1024"
                fill="currentColor"
                aria-hidden="true"
                className="-mx-0.5 flex-shrink-0"
              >
                <path d="M512 179.2c44.8 0 87.466667 8.533333 130.133333 25.6 40.533333 17.066667 76.8 40.533333 106.666667 70.4s53.333333 66.133333 70.4 106.666667c17.066667 40.533333 25.6 85.333333 25.6 130.133333s-8.533333 87.466667-25.6 130.133333c-17.066667 40.533333-40.533333 76.8-70.4 106.666667s-66.133333 53.333333-106.666667 70.4-85.333333 25.6-130.133333 25.6-87.466667-8.533333-130.133333-25.6c-40.533333-17.066667-76.8-40.533333-106.666667-70.4s-53.333333-66.133333-70.4-106.666667c-17.066667-40.533333-25.6-85.333333-25.6-130.133333 0-44.8 8.533333-87.466667 25.6-130.133333 17.066667-40.533333 40.533333-76.8 70.4-106.666667s66.133333-53.333333 106.666667-70.4 85.333333-25.6 130.133333-25.6z m0 91.733333c-42.666667 0-83.2 10.666667-121.6 32-36.266667 21.333333-66.133333 51.2-87.466667 87.466667-21.333333 36.266667-32 76.8-32 121.6s10.666667 83.2 32 121.6 51.2 66.133333 87.466667 87.466667c36.266667 21.333333 76.8 32 121.6 32 42.666667 0 83.2-10.666667 121.6-32s66.133333-51.2 87.466667-87.466667 32-76.8 32-121.6-10.666667-83.2-32-121.6c-21.333333-36.266667-51.2-66.133333-87.466667-87.466667s-78.933333-32-121.6-32z m0 130.133334c29.866667 0 55.466667 10.666667 78.933333 32 21.333333 21.333333 32 46.933333 32 78.933333 0 29.866667-10.666667 55.466667-32 78.933333-21.333333 21.333333-46.933333 32-78.933333 32s-55.466667-10.666667-78.933333-32c-21.333333-21.333333-32-46.933333-32-78.933333s10.666667-55.466667 32-78.933333c23.466667-21.333333 49.066667-32 78.933333-32z" />
              </svg>
              <span>{t("chat.startRecording")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PieSendButton({
  onClick,
  disabled,
  "aria-label": ariaLabel,
  title: titleProp,
  className,
}: {
  onClick: () => void;
  disabled: boolean;
  "aria-label"?: string;
  title?: string;
  className?: string;
}) {
  const t = useT();
  const label = ariaLabel ?? t("chat.sendMessage");
  const titleStr = titleProp ?? t("chat.sendMessage");
  const base = "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-fg-1 transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={titleStr}
      className={className ? `${base} ${className}` : base}
    >
      <svg width="16" height="16" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
        <path d="M557.397333 167.204571l293.059048 293.059048L902.192762 512l-51.712 51.712-293.059048 293.083429-51.736381-51.712L762.148571 548.571429H121.904762v-73.142858h640.243809L505.660952 218.940952l51.736381-51.736381z" />
      </svg>
    </button>
  );
}

function extractOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.host) return null;
    const path = u.pathname.length > 1 ? u.pathname : "";
    return `${u.host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Strip the scheme from a URL.origin string (e.g. "https://docs.google.com")
 * to host-only, matching the format extractOrigin returns for the live
 * preview. Used by the locked-state PINNED display so locked vs free pins
 * render with consistent visual format. Returns null when the input does
 * not parse cleanly; the caller falls back to the raw string.
 */
function extractHost(originUrl: string): string | null {
  try {
    const u = new URL(originUrl);
    if (!u.host) return null;
    return u.host;
  } catch {
    return null;
  }
}
