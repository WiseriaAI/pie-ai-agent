import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useT } from "@/lib/i18n";

interface MarkdownContentProps {
  content: string;
}

/** Flatten a React children tree back to its raw text — used to recover the
 * verbatim source of a fenced code block for the clipboard. */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Two-overlapping-squares "copy" glyph, tinted via currentColor. */
export function CopyIcon() {
  return (
    <svg viewBox="0 0 1024 1024" width="13" height="13" fill="currentColor" aria-hidden>
      <path d="M337.28 138.688a27.968 27.968 0 0 0-27.968 27.968v78.72h377.344c50.816 0 92.032 41.152 92.032 91.968v377.344h78.656a28.032 28.032 0 0 0 27.968-28.032V166.656a28.032 28.032 0 0 0-27.968-27.968H337.28z m441.408 640v78.656c0 50.816-41.216 91.968-92.032 91.968H166.656a92.032 92.032 0 0 1-91.968-91.968V337.28c0-50.816 41.152-92.032 91.968-92.032h78.72V166.656c0-50.816 41.152-91.968 91.968-91.968h520c50.816 0 91.968 41.152 91.968 91.968v520c0 50.816-41.152 92.032-91.968 92.032h-78.72zM166.656 309.312a27.968 27.968 0 0 0-27.968 28.032v520c0 15.424 12.544 27.968 27.968 27.968h520a28.032 28.032 0 0 0 28.032-27.968V337.28a28.032 28.032 0 0 0-28.032-28.032H166.656z" />
    </svg>
  );
}

/** A fenced code block with a borderless copy button in its top-right corner.
 * The button is invisible until the block is hovered/focused so it doesn't
 * clutter the reading flow. The icon sits in a square hit-area; on a successful
 * write it swaps to a "copied" label for ~1.5s, each state keyed so it
 * re-mounts and plays the shared `.scale-in` fade. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(extractText(children));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (denied permission / insecure context) — no-op.
    }
  };

  return (
    <div className="group relative my-2">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? t("chat.copied") : t("chat.copyCode")}
        className="absolute right-1.5 top-1.5 z-10 flex items-center justify-center rounded p-1 text-fg-3 opacity-0 transition-opacity duration-200 hover:text-fg-1 focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? (
          <span
            key="copied"
            className="scale-in whitespace-nowrap text-[10px] font-medium leading-none"
          >
            {t("chat.copied")}
          </span>
        ) : (
          <span key="icon" className="scale-in flex">
            <CopyIcon />
          </span>
        )}
      </button>
      <pre className="overflow-x-auto rounded border border-line bg-field p-2.5 font-mono text-[11px] leading-4 text-fg-1">
        {children}
      </pre>
    </div>
  );
}

/**
 * CommonMark spec: any line that starts with 4+ spaces (or a tab) becomes an
 * "indented code block" — rendered through the <pre> code path with mono font
 * + overflow-x-auto. LLM reasoning output occasionally lands such whitespace
 * (extra padding around bullets, copy-pasted text from the page snapshot,
 * stream chunk concatenation artifacts), turning a plain Chinese sentence
 * into a horizontally-scrolling code box. Strip those leading spaces in
 * regions OUTSIDE fenced ``` blocks so the indented-code rule no longer
 * fires unintentionally; real code (in ```...```) is preserved verbatim.
 */
function stripIncidentalIndentedCode(content: string): string {
  const lines = content.split("\n");
  let inFenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFenced = !inFenced;
      continue;
    }
    if (!inFenced) {
      lines[i] = lines[i].replace(/^(?: {4,}|\t+)/, "");
    }
  }
  return lines.join("\n");
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
  const normalized = stripIncidentalIndentedCode(content);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="mb-2 mt-3 text-[15px] font-semibold first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-2 mt-3 text-[14px] font-semibold first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-1.5 mt-2 text-[13px] font-semibold first:mt-0">
            {children}
          </h3>
        ),
        p: ({ children }) => (
          <p className="mb-2 leading-[20px] last:mb-0">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="my-2 ml-5 list-disc space-y-0.5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 ml-5 list-decimal space-y-0.5">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-[20px]">{children}</li>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-accent/40 hover:decoration-accent"
          >
            {children}
          </a>
        ),
        code: ({ className, children, ...props }) => {
          const text = typeof children === "string" ? children : String(children);
          const isBlock = Boolean(className) || text.includes("\n");
          if (!isBlock) {
            return (
              <code
                className="rounded border border-line bg-field px-1 py-0.5 font-mono text-[11px] text-fg-1"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-line pl-3 italic text-fg-2">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto rounded border border-line">
            <table className="min-w-full text-[12px]">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
            {children}
          </thead>
        ),
        th: ({ children }) => <th className="px-2.5 py-1.5">{children}</th>,
        td: ({ children }) => (
          <td className="border-b border-line/60 px-2.5 py-1.5">{children}</td>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        hr: () => <hr className="my-3 border-line" />,
        del: ({ children }) => (
          <del className="text-fg-3 line-through">{children}</del>
        ),
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}
