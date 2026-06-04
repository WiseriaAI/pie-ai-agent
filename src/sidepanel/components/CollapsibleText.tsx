import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

// Past this rendered height a user message body is considered "long" and gets
// collapsed by default (see Issue — pasted code / huge blobs blowing up the
// chat list). The +8px slack avoids a toggle that clips a single trailing line.
const COLLAPSED_MAX_PX = 240;

/**
 * Renders a user-message text body. `whitespace-pre-wrap` keeps newlines and
 * runs of spaces; `[overflow-wrap:anywhere]` lets unbroken blobs (long URLs,
 * pasted minified code, base64) wrap instead of overflowing the bubble out of
 * the panel. When the content exceeds COLLAPSED_MAX_PX it starts collapsed
 * with a bottom fade + a "show more / show less" toggle.
 */
export function CollapsibleText({ text }: { text: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflows(el.scrollHeight > COLLAPSED_MAX_PX + 8);
  }, [text]);

  const collapsed = overflows && !expanded;

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={ref}
        className="relative overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
        style={collapsed ? { maxHeight: COLLAPSED_MAX_PX } : undefined}
      >
        {text}
        {collapsed && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-field to-transparent"
          />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-center text-[12px] font-medium text-accent hover:underline"
        >
          {expanded ? t("chat.collapse") : t("chat.expandFull")}
        </button>
      )}
    </div>
  );
}
