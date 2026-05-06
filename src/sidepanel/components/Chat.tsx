import { useState, useEffect, useRef, useMemo } from "react";
import type { SkillDefinition } from "@/lib/skills";
import {
  getEnabledSkills,
  resolveSlashCommand,
  expandSlashCommand,
  normalizeSkillSlashKey,
} from "@/lib/skills";
import { getModelMeta } from "@/lib/model-router";
import { listInstances, getActiveInstance, getInstance, type DecryptedInstance } from "@/lib/instances";
import { resizePanel } from "@/lib/images/resize-panel";
import type { ImageAttachment } from "@/lib/images";
import type { UseSession } from "@/sidepanel/hooks/useSession";
import AgentStepGroup, { type AgentStepData } from "./AgentStepGroup";
import AgentConfirmCard from "./AgentConfirmCard";
import PinnedTabDropdown from "./PinnedTabDropdown";
import type { DisplayMessage } from "@/types";
import InstanceSelector from "./InstanceSelector";
import {
  getSessionMeta,
  setSessionMeta,
  metaKey,
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
        autoApproved: s.autoApproved,
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
  skills: SkillDefinition[],
): SkillDefinition[] {
  const q = normalizeSkillSlashKey(query);
  const scored: Array<{ skill: SkillDefinition; score: number }> = [];
  for (const s of skills) {
    const slug = normalizeSkillSlashKey(s.name);
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
    return (b.skill.createdAt ?? 0) - (a.skill.createdAt ?? 0);
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
    error,
    toast,
    pinnedTabs,
    pinMode,
    togglePinTab,
    clearUserPin,
    sendMessage: sessionSendMessage,
    abort,
    resolveConfirm,
    clearMessages,
    clearError,
    clearToast,
  } = session;
  // Derive convenience aliases from pinnedTabs[] for the locked-pin display.
  // Primary pin is the first entry (oldest / chat-start anchor).
  const sessionPinnedOrigin = pinnedTabs?.[0]?.origin ?? null;
  const sessionPinnedTabId = pinnedTabs?.[0]?.tabId ?? null;
  const [input, setInput] = useState("");
  const [hasConfig, setHasConfig] = useState<boolean | null>(null);
  const [pageChanged, setPageChanged] = useState(false);
  // M5 — PinnedTabDropdown open state. Lives in Chat (not the dropdown
  // itself) because the dropdown's anchor is the PINNED row in the info bar.
  const [pinDropdownOpen, setPinDropdownOpen] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<SkillDefinition[]>([]);
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

  // Phase 5 image input state
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [resizing, setResizing] = useState<Set<string>>(new Set());
  const [supportsVision, setSupportsVision] = useState<boolean>(false);
  const [attachLocalToast, setAttachLocalToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // InstanceSelector state — list of configured instances + per-session current
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [currentInstanceId, setCurrentInstanceId] = useState<string | null>(null);

  // Helper to persist instanceId to session meta
  async function persistSessionInstanceId(sessionId: string, id: string) {
    const existing = await getSessionMeta(sessionId);
    if (!existing) return;
    await setSessionMeta({ ...existing, instanceId: id });
  }

  // Load instances list + current session's instanceId on mount / sessionId change
  const sessionId = session.sessionId;
  useEffect(() => {
    listInstances().then(setInstances).catch(() => setInstances([]));
    if (!sessionId) return;

    // Effective id = per-session pin fallback to global active
    async function loadEffective() {
      const meta = await getSessionMeta(sessionId);
      const fallback = meta?.instanceId ?? (await getActiveInstance());
      setCurrentInstanceId(fallback);
    }
    loadEffective().catch(() => setCurrentInstanceId(null));

    const sessionMetaKey = metaKey(sessionId);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (sessionMetaKey in changes) {
        const newMeta = changes[sessionMetaKey]?.newValue as { instanceId?: string } | undefined;
        if (newMeta && newMeta.instanceId !== undefined) {
          setCurrentInstanceId(newMeta.instanceId);
          return;
        }
      }
      // Global active changed AND session has no own pin → re-compute fallback
      if (changes.active_instance_id) {
        loadEffective().catch(() => {});
      }
    };
    chrome.storage.local.onChanged.addListener(onChanged);
    return () => chrome.storage.local.onChanged.removeListener(onChanged);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    checkConfig();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (
        changes.active_instance_id ||
        changes.instances_index ||
        Object.keys(changes).some((k) => k.startsWith("instance_"))
      ) {
        checkConfig();
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // R9 sub-path b — clear pending image attachments when the user switches
  // to a provider that lacks vision support. The dependency array intentionally
  // contains only supportsVision so this fires on the flip (false→true and
  // true→false) rather than on every attachments change, which would cause
  // infinite re-render loops. The initial render value is false (default), so
  // we guard against clearing on mount by checking attachments.length.
  useEffect(() => {
    if (!supportsVision && attachments.length > 0) {
      showLocalToast("Switched to a non-vision provider — pending images cleared.");
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
    function reload() {
      getEnabledSkills()
        .then(setEnabledSkills)
        .catch(() => setEnabledSkills([]));
    }
    reload();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (
        Object.keys(changes).some(
          (k) => k === "enabled_skills" || k.startsWith("skill_"),
        )
      ) {
        reload();
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

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
      changeInfo: chrome.tabs.TabChangeInfo,
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
      info: chrome.tabs.TabChangeInfo,
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
      changeInfo: chrome.tabs.TabChangeInfo,
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
        return;
      }
      setHasConfig(true);
      // Vision support is per-model, resolved from the active instance.
      const activeId = await getActiveInstance();
      if (activeId) {
        const inst = await getInstance(activeId);
        if (inst) {
          const modelMeta = getModelMeta(inst.provider, inst.model);
          setSupportsVision(modelMeta?.vision ?? false);
          return;
        }
      }
      setSupportsVision(false);
    } catch {
      setHasConfig(false);
      setSupportsVision(false);
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

  const addFiles = async (files: File[]) => {
    if (!supportsVision) {
      showLocalToast("Current provider does not support image input.");
      return;
    }
    if (files.length === 0) {
      // Composer detected image data in the paste/drop event but no File
      // object was extractable (e.g. user copied an <img> from a web page —
      // clipboard carries text/uri-list / text/html, not a binary File).
      // User has to save the image to disk first and use the file picker.
      showLocalToast(
        "Couldn't read image from clipboard. Save the image to disk and use the attach button.",
      );
      return;
    }
    const room = MAX_IMAGES_PER_TURN - attachments.length;
    if (room <= 0) {
      showLocalToast(`Max ${MAX_IMAGES_PER_TURN} images per message.`);
      return;
    }
    const slice = files.slice(0, room);
    for (const f of slice) {
      const tempId = `pending_${crypto.randomUUID()}`;
      setResizing((s) => new Set(s).add(tempId));
      try {
        const r = await resizePanel(f);
        setResizing((s) => {
          const next = new Set(s);
          next.delete(tempId);
          return next;
        });
        if (!r.ok) {
          showLocalToast(`Image rejected: ${r.reason}`);
          continue;
        }
        const att: ImageAttachment = {
          kind: "image",
          id: `img_user_${crypto.randomUUID()}`,
          mediaType: r.value.mediaType,
          data: r.value.data,
          width: r.value.width,
          height: r.value.height,
          byteLength: r.value.byteLength,
        };
        setAttachments((prev) => [...prev, att]);
      } catch {
        setResizing((s) => {
          const next = new Set(s);
          next.delete(tempId);
          return next;
        });
        showLocalToast("Image processing failed.");
      }
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

  // Group consecutive agent-step messages into one AgentStepGroup. Declared
  // here, ABOVE all early returns, so hooks order stays stable across renders
  // (React error #310 happened when this was below `if (hasConfig === null)`).
  const segments = useMemo(() => buildSegments(messages), [messages]);

  const popoverOpen = slashState !== null && input !== dismissedInput;

  useEffect(() => {
    setPopoverSelected(0);
  }, [slashState?.query]);

  function pickSlashSkill(skill: SkillDefinition) {
    const slug = normalizeSkillSlashKey(skill.name) || skill.id;
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
        ? `📼 从录制创建 skill：${userInput}`
        : `📼 从录制创建 skill（${pendingRecording.stepCount} 步）`;
      expandedForLLM = `Run the "Create Skill from Recording" skill (id: create_skill_from_recording).

Pass these parameters when invoking the tool:
- recordingTrace: the verbatim text below between <recordingTrace> tags
- userPrompt: ${JSON.stringify(userPromptText)}

<recordingTrace>
${pendingRecording.trace}
</recordingTrace>

After the skill completes, briefly summarize what was created (the user will see an R10 confirm card before the new skill is persisted).`;
      if (onPendingRecordingConsumed) onPendingRecordingConsumed();
    } else if (content.startsWith("/")) {
      try {
        const skills = await getEnabledSkills();
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

    sessionSendMessage({ content, expandedForLLM, attachments: pendingAttachments });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
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
      sendMessage();
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
          <span className="caps text-fg-3">NO API KEY</span>
          <p className="text-center text-[13px] leading-5">
            Add an API key from any supported provider to start using the agent.
          </p>
          <button
            onClick={onOpenSettings}
            className="rounded-md bg-fg-1 px-4 py-2 text-[13px] font-medium text-canvas hover:opacity-90"
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  if (hasConfig === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center text-fg-3">
          <span className="caps">LOADING</span>
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
                type="button"
                onClick={() => setPinDropdownOpen((v) => !v)}
                aria-label="Open pinned tab selector"
                aria-expanded={pinDropdownOpen}
                className="flex flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-field"
              >
                <span className="caps text-fg-3">
                  {pinMode === "user" ? "PINNED ★" : isLocked ? "PINNED" : "PIN"}
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
              {pinDropdownOpen && (
                <PinnedTabDropdown
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
                />
              )}
            </>
          )}
          {!displayPinnedOrigin && <div className="flex-1" />}
          {streaming && stepCount > 0 && (
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-accent tabular">
              step {String(stepCount).padStart(2, "0")}
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
            <span className="caps text-warning">PAUSED</span>
            <span className="text-fg-1">
              Task interrupted by service worker restart.
            </span>
          </div>
          <button
            onClick={() => session.resumeTask()}
            className="rounded border border-warning-line bg-transparent px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-warning hover:bg-warning-tint/60"
            aria-label="Resume the paused task"
          >
            RESUME TASK
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 && !streaming && !pageChanged ? (
          <EmptyState
            skills={enabledSkills.slice(0, 3)}
            onPickSkill={(slug) => setInput(`/${slug} `)}
          />
        ) : (
          <div className="flex flex-col gap-[18px] px-4 py-5">
            {pageChanged && (
              <PageChangedBanner onNewTask={handleNewTask} />
            )}

            {segments.map((seg) => {
              // M5 motion: bubble-in for content rows, scale-in for confirm
              // cards (focus-pull on actionable surfaces). Wrappers carry the
              // animation class so message components stay layout-agnostic.
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
              if (msg.role === "agent-confirm") {
                return (
                  <div key={firstIndex} className="scale-in">
                    <AgentConfirmCard
                      tool={msg.tool}
                      args={msg.args}
                      resolvedElement={msg.resolvedElement}
                      riskReason={msg.riskReason}
                      resolved={msg.resolved}
                      metaSkillPreview={msg.metaSkillPreview}
                      screenshotPreview={msg.screenshotPreview}
                      openUrlPreview={msg.openUrlPreview}
                      onApprove={() =>
                        resolveConfirm(msg.confirmationId, true)
                      }
                      onReject={() =>
                        resolveConfirm(msg.confirmationId, false)
                      }
                    />
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
              return null;
            })}

            {streaming && streamingText && (
              <MessageBubble
                message={{ role: "assistant", content: streamingText }}
              />
            )}

            {/* Working indicator — visible while the agent loop is alive
                and there's no partial assistant text already streaming.
                Sits at the tail of the chat so the user has a single place
                to look to confirm "still working" — covers the gaps between
                tool calls (last step ok, next LLM round not yet started)
                where active step spinners alone could feel like a hang. */}
            {streaming && !streamingText && <WorkingIndicator />}

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
                  aria-label="Dismiss notification"
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
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void addFiles([...e.target.files]);
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
            aria-label="Dismiss"
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

      {/* Phase 5 — thumbnail row: pending spinners + ready thumbnails */}
      {(attachments.length > 0 || resizing.size > 0) && (
        <div
          role="list"
          aria-label="image attachments"
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
              <span aria-label="processing image" style={{ color: "var(--c-fg-3)", fontSize: 18 }}>
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
                alt="uploaded image preview"
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
                aria-label="remove image"
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
          title={`Send → 由 LLM 调 create_skill_from_recording 创建 skill\n\n预览（前 200 字）：\n${pendingRecording.trace.slice(0, 200)}${pendingRecording.trace.length > 200 ? "…" : ""}`}
        >
          <span
            className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-pending"
            aria-hidden="true"
          />
          <span className="font-mono text-[10px] font-semibold tracking-[0.08em] text-pending">
            REC
          </span>
          <span className="text-fg-1">
            {pendingRecording.stepCount}
            <span className="ml-1 text-fg-3">{pendingRecording.stepCount === 1 ? "step" : "steps"}</span>
          </span>
          <span className="text-fg-3">·</span>
          <span className="text-fg-2">写提示 → Send 让 LLM 创建 skill</span>
          <button
            type="button"
            aria-label="discard recording"
            data-testid="dismiss-pending-recording"
            onClick={() => onPendingRecordingConsumed?.()}
            className="ml-auto flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            ×
          </button>
        </div>
      )}

      <Composer
        input={input}
        streaming={streaming}
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
        onSend={() => sendMessage()}
        onStop={handleStop}
        onAttachClick={() => fileInputRef.current?.click()}
        onPasteFiles={(files) => void addFiles(files)}
        onDropFiles={(files) => void addFiles(files)}
        onStartRecording={onStartRecording}
        recordingDisabled={pendingRecording !== null}
        instances={instances}
        currentInstanceId={currentInstanceId}
        onInstanceChange={async (id) => {
          setCurrentInstanceId(id);
          if (sessionId) await persistSessionInstanceId(sessionId, id);
        }}
        onManageInstances={onOpenSettings}
      />
    </div>
  );
}


function EmptyState({
  skills,
  onPickSkill,
}: {
  skills: SkillDefinition[];
  onPickSkill: (slug: string) => void;
}) {
  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-14">
      <div className="flex flex-col gap-3">
        <span className="caps text-fg-3">READY</span>
        <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.015em] text-fg-1">
          What should I do<br />on this page?
        </h1>
        <p className="text-[13px] leading-5 text-fg-2">
          I can read it, click around, fill forms, manage tabs. Anything risky waits for your approval.
        </p>
      </div>

      {skills.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="caps text-fg-3">SUGGESTED</span>
            <span className="font-mono text-[10px] text-fg-3">/ for all</span>
          </div>
          <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line bg-line">
            {skills.map((s) => {
              const slug = normalizeSkillSlashKey(s.name) || s.id;
              const author = s.builtIn ? "BUILT-IN" : s.author === "agent" ? "AGENT" : "USER";
              return (
                <button
                  key={s.id}
                  onClick={() => onPickSkill(slug)}
                  className="flex flex-col gap-1 bg-surface px-4 py-3.5 text-left hover:bg-field"
                >
                  <div className="flex items-center gap-2.5">
                    <code className="font-mono text-[12px] text-accent">/{slug}</code>
                    <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                      {author}
                    </span>
                  </div>
                  {s.description && (
                    <span className="text-[12px] leading-[18px] text-fg-2">
                      {s.description}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PageChangedBanner({ onNewTask }: { onNewTask: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-fg-2">
      <span>Page changed. Start fresh?</span>
      <button
        onClick={onNewTask}
        className="rounded border border-line bg-field px-2 py-1 text-fg-1 hover:bg-line"
      >
        New task
      </button>
    </div>
  );
}

function MessageBubble({
  message,
}: {
  message: Extract<DisplayMessage, { role: "user" | "assistant" }>;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[280px] whitespace-pre-wrap rounded-[10px_10px_2px_10px] border border-line bg-field px-3.5 py-2.5 text-[13px] leading-5 text-fg-1">
          {message.content}
          {message.attachments?.map((a) =>
            a.kind === "image" ? (
              <img
                key={a.id}
                src={`data:${a.mediaType};base64,${a.data}`}
                alt="image attachment"
                width={Math.min(160, a.width)}
                className="mt-1 block rounded"
              />
            ) : (
              // R10/R13 — image bytes not persisted; evicted after SW restart,
              // session switch, or port disconnect. Badge preserved identity so
              // the user understands the image was here but is no longer cached.
              <span
                key={a.id}
                title="图片不持久化存储 — 切换会话或重启 SW 后释放"
                className="mt-1 inline-block rounded border border-line bg-field px-2 py-0.5 font-mono text-[11px] text-fg-3"
              >
                {`[图已释放] ${a.width}×${a.height}`}
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
        <span className="caps text-fg-2">AGENT</span>
      </div>
      <div className="text-[13px] leading-5 text-fg-1">
        <MarkdownContent content={message.content} />
      </div>
    </div>
  );
}

function WorkingIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Agent is working"
      className="flex items-center gap-2 px-1 py-0.5"
    >
      <span className="relative flex h-2 w-2 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-50" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      <span className="caps text-fg-3">WORKING</span>
    </div>
  );
}

function Composer({
  input,
  streaming,
  popoverOpen,
  slashState,
  popoverSelected,
  supportsVision,
  attachmentCount,
  onChange,
  onSelectPopover,
  onPickSkill,
  onKeyDown,
  onSend,
  onStop,
  onAttachClick,
  onPasteFiles,
  onDropFiles,
  onStartRecording,
  recordingDisabled,
  instances,
  currentInstanceId,
  onInstanceChange,
  onManageInstances,
}: {
  input: string;
  streaming: boolean;
  popoverOpen: boolean;
  slashState: { query: string; results: SkillDefinition[] } | null;
  popoverSelected: number;
  supportsVision: boolean;
  attachmentCount: number;
  onChange: (v: string) => void;
  onSelectPopover: (i: number) => void;
  onPickSkill: (skill: SkillDefinition) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSend: () => void;
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
  instances: DecryptedInstance[];
  currentInstanceId: string | null;
  onInstanceChange: (id: string) => void;
  onManageInstances: () => void;
}) {
  return (
    <div className="flex flex-shrink-0 flex-col gap-2 border-t border-line bg-canvas px-4 pb-4 pt-4">
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
            placeholder="Tell the agent what to do, or type / for skills…"
            rows={3}
            disabled={streaming}
            className="min-h-[60px] resize-none bg-transparent text-[13px] leading-5 text-fg-1 placeholder:text-fg-3 disabled:opacity-50"
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              // Detect ANY image in clipboard (file OR string-typed image
              // data like text/uri-list of an image URL). Without this
              // detection, paste would silently no-op when (a) provider
              // lacks vision OR (b) clipboard has image-as-URL (common
              // when copying from web pages) — user reports "no response".
              const hasImageInClipboard = Array.from(items).some((item) =>
                item.type.startsWith("image/"),
              );
              if (!hasImageInClipboard) return; // normal text paste, fall through
              e.preventDefault();
              const files: File[] = [];
              for (const item of items) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                  const f = item.getAsFile();
                  if (f) files.push(f);
                }
              }
              // Always invoke — addFiles surfaces a toast for every reason
              // (no-vision-provider / cap-exceeded / empty-files / resize-fail).
              onPasteFiles(files);
            }}
            onDrop={(e) => {
              const dropped = [...(e.dataTransfer?.files ?? [])];
              const hasImageInDrop = dropped.some((f) => f.type.startsWith("image/"));
              if (!hasImageInDrop) return; // non-image drop, leave to default
              e.preventDefault();
              const files = dropped.filter((f) => f.type.startsWith("image/"));
              onDropFiles(files);
            }}
            onDragOver={(e) => {
              e.preventDefault();
            }}
          />
          {/* Bottom row: action row */}
          <div className="flex items-center gap-2">
            <InstanceSelector
              instances={instances}
              currentId={currentInstanceId}
              locked={streaming}
              onChange={onInstanceChange}
              onManage={onManageInstances}
            />
            <div className="flex-1" />
            {/* Phase 5 — paperclip attach button (SVG, not emoji) */}
            {!streaming && (
              <button
                type="button"
                aria-label="attach image"
                disabled={!supportsVision || attachmentCount >= MAX_IMAGES_PER_TURN}
                onClick={onAttachClick}
                className="rounded border border-line px-1.5 py-1 text-fg-3 hover:border-fg-3 hover:text-fg-2 disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  !supportsVision
                    ? "Current provider does not support image input"
                    : attachmentCount >= MAX_IMAGES_PER_TURN
                      ? `Max ${MAX_IMAGES_PER_TURN} images per message`
                      : "Attach image (or paste/drop)"
                }
              >
                {/* Paperclip icon — Heroicons outline style */}
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
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            )}
            {streaming ? (
              <button
                onClick={onStop}
                className="rounded border border-warning-line bg-transparent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-warning hover:bg-warning-tint"
                title="Cancel running task"
              >
                <span className="mr-1 inline-block h-[5px] w-[5px] rounded-full bg-warning align-middle" />
                STOP
              </button>
            ) : (
              <>
                {/* Recording v1 — REC button sits next to Send when a startRecording
                    handler is provided. Disabled while pendingRecording chip is up
                    or no active session. */}
                {onStartRecording && (
                  <button
                    type="button"
                    onClick={onStartRecording}
                    disabled={recordingDisabled}
                    title="Record DOM actions on this tab"
                    aria-label="Start recording"
                    className="flex items-center gap-1.5 rounded border border-line px-2 py-1 font-mono text-[10px] tracking-[0.08em] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="inline-block h-[5px] w-[5px] rounded-full bg-fg-3" />
                    <span>REC</span>
                  </button>
                )}
                <button
                  onClick={onSend}
                  disabled={!input.trim()}
                  className="flex items-center gap-1.5 rounded border border-line px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span>Send</span>
                  <span className="font-mono text-[10px] text-fg-3">↵</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Hint row OUTSIDE the box — no chip */}
      <div className="flex items-center gap-4 px-0.5 font-mono text-[10px] tracking-[0.08em] text-fg-3">
        <span>/ skills</span>
        <span>SHIFT ↵ NEWLINE</span>
      </div>
    </div>
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
