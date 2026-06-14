import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { DropdownPanel } from "./ui/DropdownPanel";

export interface ContextRingProps {
  lastInputTokens: number | undefined;
  lastOutputTokens: number | undefined;
  totalInputTokens: number;
  totalOutputTokens: number;
  maxContextTokens: number | undefined;
}

// Ring geometry — 16x16 outer, 2px stroke. Matches neighboring composer icons
// (Send svg 16x16, REC dot, attachment +). Center is left empty intentionally:
// the arc IS the visual indicator; exact numbers live in tooltip + popover.
const RING_SIZE = 16;
const RING_RADIUS = 6;
const RING_STROKE = 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_CENTER = RING_SIZE / 2;

// Semantic threshold colors — same hex on both light and dark themes
// (verified visible on canvas #FAFBFC and #0B0D10).
const COLOR_LOW = "#6E767D";
const COLOR_MID = "#E07A4A";
const COLOR_HIGH = "#D9544A";

function colorForPercent(pct: number): string {
  if (pct >= 80) return COLOR_HIGH;
  if (pct >= 60) return COLOR_MID;
  return COLOR_LOW;
}

export default function ContextRing(props: ContextRingProps) {
  const {
    lastInputTokens,
    lastOutputTokens: _lastOutputTokens, // reserved for future use; silence unused warning
    totalInputTokens,
    totalOutputTokens,
    maxContextTokens,
  } = props;
  void _lastOutputTokens;

  const { locale, t } = useI18n();
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const shouldRender =
    lastInputTokens != null &&
    lastInputTokens > 0 &&
    maxContextTokens != null &&
    maxContextTokens > 0;

  // Compute pct unconditionally so hook order is stable across renders.
  const pct = shouldRender
    ? Math.min(100, Math.round((lastInputTokens! / maxContextTokens!) * 100))
    : 0;

  // ESC closes popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Click-outside closes popover. Deferred listener registration so the
  // open-click doesn't immediately close (same pattern as PinnedTabDropdown).
  useEffect(() => {
    if (!open) return;
    let cleanup: (() => void) | null = null;
    const timer = setTimeout(() => {
      const onDoc = (e: MouseEvent) => {
        if (
          containerRef.current &&
          !containerRef.current.contains(e.target as Node)
        ) {
          setOpen(false);
        }
      };
      document.addEventListener("mousedown", onDoc);
      cleanup = () => document.removeEventListener("mousedown", onDoc);
    }, 0);
    return () => {
      clearTimeout(timer);
      if (cleanup) cleanup();
    };
  }, [open]);

  const onClickRing = useCallback(() => setOpen((v) => !v), []);

  if (!shouldRender) return null;

  const stroke = colorForPercent(pct);
  const dashLen = (RING_CIRCUMFERENCE * pct) / 100;
  const totalSum = totalInputTokens + totalOutputTokens;
  const tooltipText = t("chat.contextRing.lastCall", {
    used: numberFormat.format(lastInputTokens!),
    max: numberFormat.format(maxContextTokens!),
    pct: numberFormat.format(pct),
  });

  return (
    <div
      ref={containerRef}
      data-testid="context-ring"
      role="button"
      aria-label={t("chat.contextRing.ariaLabel")}
      onClick={onClickRing}
      title={tooltipText}
      style={{
        position: "relative",
        width: RING_SIZE,
        height: RING_SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        style={{ display: "block" }}
      >
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          fill="none"
          stroke="var(--c-line)"
          strokeWidth={RING_STROKE}
        />
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          fill="none"
          stroke={stroke}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${dashLen} ${RING_CIRCUMFERENCE}`}
          transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
        />
      </svg>
      {/* Slide+fade enter/exit via DropdownPanel (trigger-hugging, non-portal).
          Positioning lives on the animated panel; the inner box keeps the
          visual chrome + testid + stopPropagation (DropdownPanel forwards only
          role/className/style, not onClick/data-testid). */}
      <DropdownPanel
        open={open}
        placement="above"
        style={{
          position: "absolute",
          bottom: RING_SIZE + 8,
          right: -8,
          zIndex: 50,
        }}
      >
        <div
          data-testid="context-ring-popover"
          onClick={(e) => e.stopPropagation()}
          style={{
            minWidth: 200,
            background: "var(--c-canvas)",
            border: "1px solid var(--c-line)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
            cursor: "default",
          }}
        >
          <div
            style={{
              padding: "10px 14px 8px",
              borderBottom: "1px solid var(--c-line)",
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 500,
              fontSize: 10,
              letterSpacing: "0.14em",
              color: "var(--c-fg-3)",
              textTransform: "uppercase",
            }}
          >
            {t("chat.contextRing.sessionUsage")}
          </div>
          <PopoverRow
            label={t("chat.contextRing.input")}
            value={totalInputTokens}
            numberFormat={numberFormat}
          />
          <PopoverRow
            label={t("chat.contextRing.output")}
            value={totalOutputTokens}
            numberFormat={numberFormat}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 14px 10px",
              borderTop: "1px solid var(--c-line)",
            }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                letterSpacing: "0.1em",
                color: "var(--c-fg-3)",
                textTransform: "uppercase",
              }}
            >
              {t("chat.contextRing.total")}
            </span>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontWeight: 600,
                fontSize: 13,
                color: "var(--c-fg-1)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {numberFormat.format(totalSum)}
            </span>
          </div>
        </div>
      </DropdownPanel>
    </div>
  );
}

function PopoverRow({
  label,
  value,
  numberFormat,
}: {
  label: string;
  value: number;
  numberFormat: Intl.NumberFormat;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 14px",
      }}
    >
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 12,
          color: "var(--c-fg-2)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontWeight: 500,
          fontSize: 12,
          color: "var(--c-fg-1)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {numberFormat.format(value)}
      </span>
    </div>
  );
}
