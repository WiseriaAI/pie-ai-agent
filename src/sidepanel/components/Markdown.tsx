import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
}

/**
 * Renders markdown with dark-theme Tailwind styling.
 * Used for assistant chat messages and agent task summaries.
 *
 * Supports: headings, lists, links, tables, blockquotes, code blocks,
 * inline code, bold/italic/strikethrough, horizontal rules (via GFM).
 */
export default function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="mt-3 mb-2 text-base font-bold first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mt-3 mb-2 text-sm font-bold first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mt-2 mb-1.5 text-sm font-semibold first:mt-0">
            {children}
          </h3>
        ),
        p: ({ children }) => (
          <p className="mb-2 leading-relaxed last:mb-0">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="my-2 ml-5 list-disc space-y-0.5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 ml-5 list-decimal space-y-0.5">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 underline decoration-blue-400/50 hover:text-blue-300 hover:decoration-blue-300"
          >
            {children}
          </a>
        ),
        code: ({ className, children, ...props }) => {
          // Distinguish inline code from fenced blocks:
          // - Language-tagged blocks carry `className="language-*"`
          // - Language-less fenced blocks have no className, but their content
          //   always contains at least one newline. Inline code never has newlines.
          const text = typeof children === "string" ? children : String(children);
          const isBlock = Boolean(className) || text.includes("\n");
          if (!isBlock) {
            return (
              <code
                className="rounded bg-neutral-900 px-1 py-0.5 text-xs"
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
          <pre className="my-2 overflow-x-auto rounded bg-neutral-900 p-2 text-xs">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-neutral-600 pl-3 text-neutral-400 italic">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="min-w-full text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="border-b border-neutral-700 text-left font-semibold">
            {children}
          </thead>
        ),
        th: ({ children }) => <th className="px-2 py-1">{children}</th>,
        td: ({ children }) => (
          <td className="border-b border-neutral-800/60 px-2 py-1">
            {children}
          </td>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        hr: () => <hr className="my-3 border-neutral-700" />,
        del: ({ children }) => (
          <del className="text-neutral-500 line-through">{children}</del>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
