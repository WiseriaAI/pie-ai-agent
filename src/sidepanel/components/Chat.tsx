import { useState, useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/model-router";
import type { PortMessageToPanel } from "@/types";
import { getActiveProvider, getProviderConfig } from "@/lib/storage";

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatProps {
  onGoToSettings: () => void;
}

export default function Chat({ onGoToSettings }: ChatProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasConfig, setHasConfig] = useState<boolean | null>(null);
  const [pageChanged, setPageChanged] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    checkConfig();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

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

  function sendMessage(text?: string) {
    const content = (text ?? input).trim();
    if (!content || streaming) return;

    setInput("");
    setError(null);

    const userMessage: DisplayMessage = { role: "user", content };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setStreaming(true);
    setStreamingText("");

    // Build chat messages for the API (include history)
    const chatMessages: ChatMessage[] = updatedMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

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
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: accumulated },
        ]);
        setStreamingText("");
        setStreaming(false);
        portRef.current = null;
      } else if (message.type === "chat-error") {
        finished = true;
        setError(message.error);
        if (accumulated) {
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

    port.onDisconnect.addListener(() => {
      if (!finished) {
        if (accumulated) {
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
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

        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}

        {streaming && streamingText && (
          <MessageBubble
            message={{ role: "assistant", content: streamingText }}
          />
        )}

        {streaming && !streamingText && <TypingIndicator />}

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-neutral-800 pt-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this page..."
            rows={1}
            disabled={streaming}
            className="flex-1 resize-none rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-blue-600 focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={() => sendMessage()}
            disabled={streaming || !input.trim()}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
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

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
          isUser
            ? "bg-blue-600 text-white"
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

function MarkdownContent({ content }: { content: string }) {
  // Basic markdown: code blocks, inline code, bold
  const parts: React.ReactNode[] = [];
  let remaining = content;
  let key = 0;

  while (remaining.length > 0) {
    // Code blocks
    const codeBlockMatch = remaining.match(/^```(\w*)\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      parts.push(
        <pre
          key={key++}
          className="my-2 overflow-x-auto rounded bg-neutral-900 p-2 text-xs"
        >
          <code>{codeBlockMatch[2]}</code>
        </pre>,
      );
      remaining = remaining.slice(codeBlockMatch[0].length);
      continue;
    }

    // Inline code
    const inlineCodeMatch = remaining.match(/^`([^`]+)`/);
    if (inlineCodeMatch) {
      parts.push(
        <code
          key={key++}
          className="rounded bg-neutral-900 px-1 py-0.5 text-xs"
        >
          {inlineCodeMatch[1]}
        </code>,
      );
      remaining = remaining.slice(inlineCodeMatch[0].length);
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push(
        <strong key={key++} className="font-semibold">
          {boldMatch[1]}
        </strong>,
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Regular text — take up to next special character
    const nextSpecial = remaining.search(/[`*]/);
    if (nextSpecial === -1) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    } else if (nextSpecial === 0) {
      // Special char didn't match patterns above, consume it
      parts.push(<span key={key++}>{remaining[0]}</span>);
      remaining = remaining.slice(1);
    } else {
      parts.push(<span key={key++}>{remaining.slice(0, nextSpecial)}</span>);
      remaining = remaining.slice(nextSpecial);
    }
  }

  return <>{parts}</>;
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
