import { useState, useEffect, useRef, useMemo } from "react";
import type { ChatMessage } from "@/lib/model-router";
import type { PortMessageToPanel, ResolvedElement } from "@/types";
import type { SkillDefinition } from "@/lib/skills";
import {
  getEnabledSkills,
  resolveSlashCommand,
  expandSlashCommand,
  normalizeSkillSlashKey,
} from "@/lib/skills";
import { getActiveProvider, getProviderConfig } from "@/lib/storage";
import AgentStepBubble from "./AgentStepBubble";
import AgentConfirmCard from "./AgentConfirmCard";
import AgentSummary from "./AgentSummary";
import MarkdownContent from "./Markdown";
import SkillSlashPopover from "./SkillSlashPopover";

type DisplayMessage =
  | {
      role: "user";
      content: string;
      /** Phase 2.6+: when set, this is the LLM-facing rewrite of a slash
       *  command; `content` remains the raw `/foo` for chat-history display.
       *  Send `expandedForLLM` to the model instead of `content`. */
      expandedForLLM?: string;
    }
  | { role: "assistant"; content: string }
  | {
      role: "agent-step";
      stepIndex: number;
      tool: string;
      args: unknown;
      resolvedElement?: ResolvedElement;
      status: "pending" | "ok" | "error";
      observation?: string;
    }
  | {
      role: "agent-confirm";
      confirmationId: string;
      tool: string;
      args: unknown;
      resolvedElement: ResolvedElement;
      riskReason: string;
      resolved?: "approved" | "rejected";
      // Phase 2.6 — for create_skill / update_skill confirms, the SW sends
      // the effective merged skill so AgentConfirmCard can render full
      // content (P0-D / adv-1).
      metaSkillPreview?: {
        existing: SkillDefinition | null;
        effective: SkillDefinition;
      };
    }
  | {
      role: "agent-summary";
      success: boolean;
      summary: string;
      stepCount: number;
    };

interface ChatProps {
  onGoToSettings: () => void;
  /** When set, pre-fills the input field; cleared after consumption. */
  prefillInput?: string;
  onPrefillConsumed?: () => void;
}

/**
 * Score and sort skills for the slash popover. Returns skills with score > 0
 * sorted by score desc, then createdAt desc. Empty query returns all skills
 * sorted purely by createdAt (newest first). Built-in skills (createdAt=0)
 * sink naturally.
 */
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
      score = 1; // include all
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

export default function Chat({ onGoToSettings, prefillInput, onPrefillConsumed }: ChatProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasConfig, setHasConfig] = useState<boolean | null>(null);
  const [pageChanged, setPageChanged] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<SkillDefinition[]>([]);
  // popoverSelected: keyboard-highlighted index in slash popover.
  const [popoverSelected, setPopoverSelected] = useState(0);
  // dismissedInput: when set, popover stays closed for this exact input
  // value (until the user types something else). Lets Esc dismiss without
  // wiping the user's draft.
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    checkConfig();
  }, []);

  // Load + watch enabled skills for the slash popover. chrome.storage
  // onChange fires for any skill_<id> CRUD or enabled_skills toggle, so
  // the popover stays in sync with SkillsList edits.
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

  // Consume prefillInput: set it into the input field without clobbering user
  // input during streaming (guard on truthy to skip undefined/empty updates).
  useEffect(() => {
    if (prefillInput) {
      setInput(prefillInput);
      // Skip the slash popover for programmatic prefills (user just clicked
      // Run on a skill in SkillsList — they already chose; one Enter sends).
      // Once the user edits the input, dismissedInput auto-clears via the
      // textarea onChange handler.
      if (prefillInput.startsWith("/")) {
        setDismissedInput(prefillInput);
      }
      onPrefillConsumed?.();
    }
  }, [prefillInput]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect URL changes on active tab
  useEffect(() => {
    const listener = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (changeInfo.url && tab.active && messages.length > 0) {
        setPageChanged(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    return () => chrome.tabs.onUpdated.removeListener(listener);
  }, [messages.length]);

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

  // ── Phase 2.6+ slash popover state machine ────────────────────────────
  //
  // Popover is open iff:
  //   (a) input starts with "/" AND
  //   (b) there is no whitespace after the leading slash (i.e. user is still
  //       inside the skill-key token, not yet typing args), AND
  //   (c) the current input string is not the dismissedInput value.
  //
  // Filter / sort: exact-match (id or name slug) > prefix-match > substring
  // > everything-else; tie-break by createdAt desc. Empty query (just "/")
  // returns all enabled skills sorted by recency.
  const slashState = useMemo(() => {
    if (!input.startsWith("/")) return null;
    const m = input.match(/^\/(\S*)$/);
    if (!m) return null;
    const query = m[1];
    return { query, results: filterAndSortSkillsForSlash(query, enabledSkills) };
  }, [input, enabledSkills]);

  const popoverOpen = slashState !== null && input !== dismissedInput;

  // Reset highlighted row when query changes (new filter list = new top-1).
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
    if (!content || streaming) return;

    setInput("");
    setError(null);

    // Phase 2.6+ slash-command resolution: detect /<key> matching an enabled
    // skill (by id or normalized name) and rewrite for the LLM. The raw
    // slash text stays in chat history for display; only the LLM-facing
    // copy is expanded. Unknown /commands fall through unchanged.
    let expandedForLLM: string | undefined = undefined;
    if (content.startsWith("/")) {
      try {
        const enabledSkills = await getEnabledSkills();
        const match = resolveSlashCommand(content, enabledSkills);
        if (match) {
          expandedForLLM = expandSlashCommand(match);
        }
      } catch {
        // resolver failure is non-fatal; pass raw content through
      }
    }

    const userMessage: DisplayMessage = { role: "user", content, expandedForLLM };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setStreaming(true);
    setStreamingText("");

    // Build chat messages for the API — only user/assistant text, skip agent-* display messages.
    // For user messages with a slash-command expansion, send the expanded text.
    const chatMessages: ChatMessage[] = updatedMessages
      .filter(
        (m): m is { role: "user"; content: string; expandedForLLM?: string } | { role: "assistant"; content: string } =>
          m.role === "user" || m.role === "assistant",
      )
      .map((m) =>
        m.role === "user" && m.expandedForLLM
          ? { role: "user" as const, content: m.expandedForLLM }
          : { role: m.role, content: m.content },
      );

    // Establish port connection
    const port = chrome.runtime.connect({ name: "chat-stream" });
    portRef.current = port;

    let accumulated = "";
    let finished = false;

    port.onMessage.addListener((message: PortMessageToPanel) => {
      if (message.type === "chat-chunk") {
        accumulated += message.text;
        setStreamingText(accumulated);
      } else if (message.type === "chat-done") {
        finished = true;
        // Only push assistant message if there's actual (non-whitespace) content.
        // LLMs sometimes emit a stray "\n" or " " before a tool_call; without
        // this guard, chat-done (or agent-step flush below) creates an empty bubble.
        if (accumulated.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: accumulated },
          ]);
        }
        setStreamingText("");
        setStreaming(false);
        portRef.current = null;
      } else if (message.type === "chat-error") {
        finished = true;
        setError(message.error);
        if (accumulated.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: accumulated },
          ]);
        }
        setStreamingText("");
        setStreaming(false);
        portRef.current = null;
      } else if (message.type === "agent-step") {
        // Flush any pending streaming text as an assistant message.
        // Require non-whitespace content — a lone "\n" emitted before a tool_call
        // would otherwise render as an empty MarkdownContent bubble.
        if (accumulated.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: accumulated },
          ]);
          setStreamingText("");
        }
        // Always reset accumulated and streamingText — even if content was just
        // whitespace we don't want it re-rendered as a partial streaming bubble.
        accumulated = "";
        setStreamingText("");
        const { stepIndex, tool, args, resolvedElement, status, observation } =
          message;
        setMessages((prev) => {
          // Search in reverse for an existing agent-step with same stepIndex+tool to update in-place
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i];
            if (m.role !== "agent-step" && m.role !== "agent-confirm") break;
            if (
              m.role === "agent-step" &&
              m.stepIndex === stepIndex &&
              m.tool === tool
            ) {
              const updated = [...prev];
              updated[i] = {
                role: "agent-step",
                stepIndex,
                tool,
                args,
                resolvedElement,
                status,
                observation,
              };
              return updated;
            }
          }
          // No existing entry — push new
          return [
            ...prev,
            {
              role: "agent-step",
              stepIndex,
              tool,
              args,
              resolvedElement,
              status,
              observation,
            },
          ];
        });
      } else if (message.type === "agent-confirm-request") {
        const { confirmationId, tool, args, resolvedElement, riskReason, metaSkillPreview } =
          message;
        setMessages((prev) => [
          ...prev,
          {
            role: "agent-confirm",
            confirmationId,
            tool,
            args,
            resolvedElement,
            riskReason,
            metaSkillPreview,
            resolved: undefined,
          },
        ]);
      } else if (message.type === "agent-done-task") {
        finished = true;
        const { success, summary, stepCount } = message;
        setMessages((prev) => [
          ...prev,
          { role: "agent-summary", success, summary, stepCount },
        ]);
        setStreamingText("");
        setStreaming(false);
        portRef.current = null;
      }
    });

    port.onDisconnect.addListener(() => {
      if (!finished) {
        if (accumulated.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: accumulated },
          ]);
        }
        setStreamingText("");
        setStreaming(false);
        portRef.current = null;
      }
    });

    port.postMessage({ type: "chat-start", messages: chatMessages });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Phase 2.6+ slash popover: when open AND has results, intercept arrow
    // navigation, Enter/Tab pick, and Escape dismiss before falling through
    // to the default Enter-to-send behavior.
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
    // Popover open but empty (no matches): Esc still dismisses. Other keys
    // fall through so the user can keep typing.
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
    const port = portRef.current;
    if (!port) return;
    try {
      port.postMessage({ type: "chat-abort" });
    } catch {
      // port may be in the process of closing; that's fine — SW-side
      // onDisconnect will fire its own abort path.
    }
  }

  // No config — guide user to settings
  if (hasConfig === false) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 pt-20 text-neutral-500">
        <p className="text-sm">No API key configured.</p>
        <button
          onClick={onGoToSettings}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Go to Settings
        </button>
      </div>
    );
  }

  // Loading
  if (hasConfig === null) {
    return (
      <div className="flex items-center justify-center pt-20 text-neutral-500">
        <p className="text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {pageChanged && (
          <div className="flex items-center justify-between rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
            <span>Page changed. Start a new conversation?</span>
            <button
              onClick={() => {
                setMessages([]);
                setPageChanged(false);
                setError(null);
              }}
              className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
            >
              New Chat
            </button>
          </div>
        )}

        {messages.length === 0 && !streaming && !pageChanged && (
          <EmptyState onSend={sendMessage} />
        )}

        {messages.map((msg, i) => {
          if (msg.role === "user" || msg.role === "assistant") {
            return <MessageBubble key={i} message={msg} />;
          }
          if (msg.role === "agent-step") {
            return (
              <AgentStepBubble
                key={i}
                stepIndex={msg.stepIndex}
                tool={msg.tool}
                args={msg.args}
                resolvedElement={msg.resolvedElement}
                status={msg.status}
                observation={msg.observation}
              />
            );
          }
          if (msg.role === "agent-confirm") {
            return (
              <AgentConfirmCard
                key={i}
                tool={msg.tool}
                args={msg.args}
                resolvedElement={msg.resolvedElement}
                riskReason={msg.riskReason}
                resolved={msg.resolved}
                metaSkillPreview={msg.metaSkillPreview}
                onApprove={() => {
                  const port = portRef.current;
                  if (!port) return;
                  port.postMessage({
                    type: "agent-confirm-response",
                    confirmationId: msg.confirmationId,
                    approved: true,
                  });
                  setMessages((prev) =>
                    prev.map((m, idx) =>
                      idx === i && m.role === "agent-confirm"
                        ? { ...m, resolved: "approved" as const }
                        : m,
                    ),
                  );
                }}
                onReject={() => {
                  const port = portRef.current;
                  if (!port) return;
                  port.postMessage({
                    type: "agent-confirm-response",
                    confirmationId: msg.confirmationId,
                    approved: false,
                  });
                  setMessages((prev) =>
                    prev.map((m, idx) =>
                      idx === i && m.role === "agent-confirm"
                        ? { ...m, resolved: "rejected" as const }
                        : m,
                    ),
                  );
                }}
              />
            );
          }
          if (msg.role === "agent-summary") {
            return (
              <AgentSummary
                key={i}
                success={msg.success}
                summary={msg.summary}
                stepCount={msg.stepCount}
              />
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
          <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-neutral-800 pt-3">
        <div className="relative">
          {popoverOpen && slashState && (
            <SkillSlashPopover
              skills={slashState.results}
              query={slashState.query}
              selectedIndex={popoverSelected}
              onSelect={setPopoverSelected}
              onPick={pickSlashSkill}
            />
          )}
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // User edited away from the dismissed value → re-arm popover.
                if (dismissedInput !== null && e.target.value !== dismissedInput) {
                  setDismissedInput(null);
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this page... (type / to insert a skill)"
              rows={1}
              disabled={streaming}
              className="flex-1 resize-none rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-blue-600 focus:outline-none disabled:opacity-50"
            />
            {streaming ? (
              <button
                onClick={handleStop}
                className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
                title="Cancel the running task"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim()}
                className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onSend }: { onSend: (text: string) => void }) {
  const suggestions = [
    "Summarize this page",
    "Extract key information",
    "Translate page content",
  ];

  return (
    <div className="flex flex-col items-center gap-4 pt-16 text-neutral-500">
      <p className="text-sm">Ask anything about the current page</p>
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onSend(s)}
            className="rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600 hover:text-neutral-100"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
}: {
  message: { role: "user" | "assistant"; content: string };
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "whitespace-pre-wrap bg-blue-600 text-white"
            : "bg-neutral-800 text-neutral-100"
        }`}
      >
        {isUser ? (
          message.content
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  );
}


function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="rounded-lg bg-neutral-800 px-4 py-3">
        <div className="flex gap-1">
          <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-500 [animation-delay:0ms]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-500 [animation-delay:150ms]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-500 [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
