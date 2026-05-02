import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
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
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded border border-line bg-field p-2.5 font-mono text-[11px] leading-4 text-fg-1">
            {children}
          </pre>
        ),
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
