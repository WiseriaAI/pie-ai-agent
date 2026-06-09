import { useState } from "react";
import { useT } from "@/lib/i18n";
import MarkdownContent from "./Markdown";

interface ThinkingSectionProps {
  thinking: string;
  /** 流式进行中：显示"思考中…"而非"思考过程"。 */
  streaming: boolean;
}

export default function ThinkingSection({ thinking, streaming }: ThinkingSectionProps) {
  const [open, setOpen] = useState(false);
  const t = useT();
  if (!thinking && !streaming) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3 hover:text-fg-2"
      >
        <span
          className="inline-block transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ›
        </span>
        <span>{streaming ? t("thinking.inProgress") : t("thinking.label")}</span>
      </button>
      {open && thinking && (
        <div className="view-enter ml-3 border-l border-line pl-2.5 text-[12px] leading-5 text-fg-2">
          <MarkdownContent content={thinking} />
        </div>
      )}
    </div>
  );
}
