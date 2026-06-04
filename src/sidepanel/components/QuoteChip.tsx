import { useState } from "react";
import { useT } from "@/lib/i18n";
import type { Quote } from "@/types";
import { QuoteGlyph } from "./icons";

type Props = {
  quote: Quote;
  onRemove: (id: string) => void;
};

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function QuoteChip({ quote, onRemove }: Props) {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const isText = quote.kind === "text";
  const source = sourceLabel(quote.sourceUrl);

  return (
    <span
      className="relative flex max-w-full items-center gap-2 rounded-[10px] bg-accent-tint py-1 pl-1 pr-2.5 text-[11px]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {isText ? (
        <span
          aria-hidden
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] bg-accent text-canvas"
        >
          <QuoteGlyph />
        </span>
      ) : (
        <span
          aria-hidden
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-[7px] border border-line bg-canvas"
        >
          {quote.imageDataUrl && (
            <img src={quote.imageDataUrl} alt="" className="h-full w-full object-cover" />
          )}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] leading-[18px] text-fg-1">
          {isText ? (
            quote.text
          ) : (
            <>
              <span className="text-fg-2">{quote.role}</span>
              <span className="text-fg-3"> · </span>
              {`"${quote.accessibleName}"`}
            </>
          )}
        </span>
        <span className="caps shrink-0 text-fg-3" style={{ fontSize: 9 }}>
          {source}
        </span>
      </span>
      <button
        type="button"
        aria-label={t("quoteChip.removeQuote")}
        onClick={() => onRemove(quote.id)}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[13px] leading-none text-fg-3 hover:text-fg-1"
      >
        ×
      </button>
      {hovered && (
        <div
          role="tooltip"
          className="absolute bottom-full left-0 z-50 mb-1.5 max-w-[320px] rounded-md border border-line bg-canvas p-2 text-[11px] text-fg-1 shadow"
          style={{ whiteSpace: "normal" }}
        >
          {isText ? (
            <>
              <div className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words">
                {quote.text}
              </div>
              <div className="caps mt-1 truncate text-fg-3" style={{ fontSize: 9 }}>
                {quote.sourceUrl}
              </div>
            </>
          ) : (
            <>
              {quote.imageDataUrl ? (
                <img
                  src={quote.imageDataUrl}
                  alt=""
                  style={{ maxWidth: 200, maxHeight: 120 }}
                  className="rounded"
                />
              ) : (
                <div className="italic text-fg-3">{t("quoteChip.screenshotUnavailable")}</div>
              )}
              <div className="mt-1 text-fg-2">role: {quote.role}</div>
              <div className="text-fg-2">name: {quote.accessibleName}</div>
              <div className="max-h-[80px] overflow-auto whitespace-pre-wrap break-words text-fg-2">
                {quote.textContent}
              </div>
              <div className="caps mt-1 truncate text-fg-3" style={{ fontSize: 9 }}>
                {quote.sourceUrl}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
