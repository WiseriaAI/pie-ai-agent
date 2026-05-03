import { useState, useEffect, useRef, useMemo } from "react";
import type { SkillDefinition } from "@/lib/skills";
import {
  getEnabledSkills,
  resolveSlashCommand,
  expandSlashCommand,
  normalizeSkillSlashKey,
} from "@/lib/skills";
import { getActiveProvider, getProviderConfig } from "@/lib/storage";
import type { UseSession } from "@/sidepanel/hooks/useSession";
import AgentStepBubble from "./AgentStepBubble";
import AgentConfirmCard from "./AgentConfirmCard";
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
}: ChatProps) {
  const {
    ready,
    messages,
    streaming,
    streamingText,
    error,
    toast,
    pinnedOrigin: sessionPinnedOrigin,
    sendMessage: sessionSendMessage,
    abort,
    resolveConfirm,
    clearMessages,
    clearError,
    clearToast,
  } = session;
  const [input, setInput] = useState("");
  const [hasConfig, setHasConfig] = useState<boolean | null>(null);
  const [pageChanged, setPageChanged] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<SkillDefinition[]>([]);
  const [popoverSelected, setPopoverSelected] = useState(0);
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  // Live preview of the user's currently-active tab origin. Only used
  // when the session is empty (no messages, not streaming) — that's when
  // the user can still freely tab-switch and the panel reflects "the tab
  // your next first-message will lock to". Once messages exist, the
  // display flips to the persisted `sessionPinnedOrigin` (frozen).
  const [livePinnedOrigin, setLivePinnedOrigin] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    checkConfig();
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
  const isLocked = streaming || messages.length > 0;

  useEffect(() => {
    if (isLocked) {
      // No live tracking when locked — the displayed pin comes from
      // sessionPinnedOrigin (session meta) and storage onChanged keeps
      // it fresh. Skip the chrome.tabs listeners entirely so they don't
      // burn cycles in the locked state.
      return;
    }
    async function refreshLiveOrigin() {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        setLivePinnedOrigin(tab?.url ? extractOrigin(tab.url) : null);
      } catch {
        // non-fatal — keep prior value
      }
    }

    void refreshLiveOrigin();

    const onActivated = () => {
      void refreshLiveOrigin();
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (changeInfo.url && tab.active) {
        void refreshLiveOrigin();
      }
    };
    const onFocusChanged = (winId: number) => {
      // chrome.windows.WINDOW_ID_NONE === -1 fires when chrome loses focus
      // entirely; ignore to avoid clearing pin on app-switch.
      if (winId === chrome.windows.WINDOW_ID_NONE) return;
      void refreshLiveOrigin();
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

  // Separate effect: pageChanged banner only cares about live URL
  // changes on the pinned tab while the session is non-empty. Kept in
  // its own listener so the locked-state main effect can early-return.
  useEffect(() => {
    if (messages.length === 0) return;
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (changeInfo.url && tab.active) {
        setPageChanged(true);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onUpdated);
  }, [messages.length]);

  // Display source: locked → persisted session pin; free → live preview.
  // Both paths normalize to host-only via extractHost so the visual
  // format is consistent across states.
  const displayPinnedOrigin = isLocked
    ? sessionPinnedOrigin
      ? extractHost(sessionPinnedOrigin) ?? sessionPinnedOrigin
      : null
    : livePinnedOrigin;

  async function checkConfig() {
    const active = await getActiveProvider();
    if (!active) {
      setHasConfig(false);
      return;
    }
    try {
      const config = await getProviderConfig(active);
      setHasConfig(!!config);
    } catch {
      setHasConfig(false);
    }
  }

  const slashState = useMemo(() => {
    if (!input.startsWith("/")) return null;
    const m = input.match(/^\/(\S*)$/);
    if (!m) return null;
    const query = m[1];
    return { query, results: filterAndSortSkillsForSlash(query, enabledSkills) };
  }, [input, enabledSkills]);

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
    const content = (text ?? input).trim();
    if (!content || streaming || !ready) return;

    setInput("");
    clearError();

    let expandedForLLM: string | undefined = undefined;
    if (content.startsWith("/")) {
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

    sessionSendMessage({ content, expandedForLLM });
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
      {/* Pinned origin + provider label info bar */}
      {(displayPinnedOrigin || providerLabel) && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 py-1.5">
          {displayPinnedOrigin && (
            <>
              <span className="caps text-fg-3">{isLocked ? "PINNED" : "PIN"}</span>
              <span className="flex-1 truncate font-mono text-[11px] text-fg-2">
                {displayPinnedOrigin}
              </span>
            </>
          )}
          {!displayPinnedOrigin && <div className="flex-1" />}
          {streaming && stepCount > 0 && (
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-accent tabular">
              step {String(stepCount).padStart(2, "0")}
            </span>
          )}
          {providerLabel && (
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-2">
              {providerLabel}
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

            {messages.map((msg, i) => {
              // M5 motion: bubble-in for content rows, scale-in for confirm
              // cards (focus-pull on actionable surfaces). Wrappers carry the
              // animation class so message components stay layout-agnostic.
              if (msg.role === "user" || msg.role === "assistant") {
                return (
                  <div key={i} className="bubble-in">
                    <MessageBubble message={msg} />
                  </div>
                );
              }
              if (msg.role === "agent-step") {
                return (
                  <div key={i} className="bubble-in">
                    <AgentStepBubble
                      stepIndex={msg.stepIndex}
                      tool={msg.tool}
                      args={msg.args}
                      resolvedElement={msg.resolvedElement}
                      status={msg.status}
                      observation={msg.observation}
                    />
                  </div>
                );
              }
              if (msg.role === "agent-confirm") {
                return (
                  <div key={i} className="scale-in">
                    <AgentConfirmCard
                      tool={msg.tool}
                      args={msg.args}
                      resolvedElement={msg.resolvedElement}
                      riskReason={msg.riskReason}
                      resolved={msg.resolved}
                      metaSkillPreview={msg.metaSkillPreview}
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
                  <div key={i} className="bubble-in">
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
                  <div key={i} className="scale-in">
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

            {streaming && !streamingText && messages.at(-1)?.role !== "agent-step" && (
              <TypingIndicator />
            )}

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

      <Composer
        input={input}
        streaming={streaming}
        popoverOpen={popoverOpen}
        slashState={slashState}
        popoverSelected={popoverSelected}
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
  message: { role: "user" | "assistant"; content: string };
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[280px] whitespace-pre-wrap rounded-[10px_10px_2px_10px] border border-line bg-field px-3.5 py-2.5 text-[13px] leading-5 text-fg-1">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex max-w-[320px] flex-col gap-1.5">
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

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-1">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-3 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-3 [animation-delay:200ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-3 [animation-delay:400ms]" />
    </div>
  );
}

function Composer({
  input,
  streaming,
  popoverOpen,
  slashState,
  popoverSelected,
  onChange,
  onSelectPopover,
  onPickSkill,
  onKeyDown,
  onSend,
  onStop,
}: {
  input: string;
  streaming: boolean;
  popoverOpen: boolean;
  slashState: { query: string; results: SkillDefinition[] } | null;
  popoverSelected: number;
  onChange: (v: string) => void;
  onSelectPopover: (i: number) => void;
  onPickSkill: (skill: SkillDefinition) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex flex-shrink-0 flex-col gap-2 border-t border-line bg-canvas px-4 pb-4 pt-3">
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
        <div className="flex items-start gap-2 rounded-[10px] border border-line bg-field px-3.5 py-3 focus-within:border-accent-line">
          <textarea
            value={input}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Tell the agent what to do, or type / for skills…"
            rows={1}
            disabled={streaming}
            className="flex-1 resize-none bg-transparent text-[13px] leading-5 text-fg-1 placeholder:text-fg-3 disabled:opacity-50"
          />
          {streaming ? (
            <button
              onClick={onStop}
              className="self-end rounded border border-warning-line bg-transparent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-warning hover:bg-warning-tint"
              title="Cancel running task"
            >
              <span className="mr-1 inline-block h-[5px] w-[5px] rounded-full bg-warning align-middle" />
              STOP
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!input.trim()}
              className="flex items-center gap-1.5 self-end rounded border border-line px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>Send</span>
              <span className="font-mono text-[10px] text-fg-3">↵</span>
            </button>
          )}
        </div>
      </div>
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
