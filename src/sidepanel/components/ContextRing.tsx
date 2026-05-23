import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ContextRingProps {
  lastInputTokens: number | undefined;
  lastOutputTokens: number | undefined;
  totalInputTokens: number;
  totalOutputTokens: number;
  maxContextTokens: number | undefined;
}

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const TRACK_COLOR = "#26262C";
const COLOR_LOW = "#6E767D";
const COLOR_MID = "#E07A4A";
const COLOR_HIGH = "#D9544A";

function colorForPercent(pct: number): string {
  if (pct >= 80) return COLOR_HIGH;
  if (pct >= 60) return COLOR_MID;
  return COLOR_LOW;
}

const numberFormat = new Intl.NumberFormat("en");

export default function ContextRing(props: ContextRingProps) {
  const {
    lastInputTokens,
    lastOutputTokens,
    totalInputTokens,
    totalOutputTokens,
    maxContextTokens,
  } = props;

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const shouldRender =
    lastInputTokens != null &&
    lastInputTokens > 0 &&
    maxContextTokens != null &&
    maxContextTokens > 0;

  const pct = useMemo(() => {
    if (!shouldRender) return 0;
    return Math.min(
      100,
      Math.round((lastInputTokens! / maxContextTokens!) * 100),
    );
  }, [shouldRender, lastInputTokens, maxContextTokens]);

  const stroke = colorForPercent(pct);
  const dashLen = (RING_CIRCUMFERENCE * pct) / 100;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    // Defer registration so the click that opened the popover doesn't
    // immediately close it (same pattern as PinnedTabDropdown).
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  const onClickRing = useCallback(() => setOpen((v) => !v), []);

  if (!shouldRender) return null;

  const totalSum = totalInputTokens + totalOutputTokens;
  const isHigh = pct >= 80;
  const tooltipText =
    `Last call ${numberFormat.format(lastInputTokens!)} / ` +
    `${numberFormat.format(maxContextTokens!)} (${pct}%)`;

  return (
    <div
      ref={containerRef}
      data-testid="context-ring"
      onClick={onClickRing}
      title={tooltipText}
      style={{
        position: "relative",
        width: 22,
        height: 22,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <svg
        width={22}
        height={22}
        viewBox="0 0 22 22"
        style={{ position: "absolute", top: 0, left: 0 }}
      >
        <circle
          cx={11}
          cy={11}
          r={RING_RADIUS}
          fill="none"
          stroke={TRACK_COLOR}
          strokeWidth={2}
        />
        <circle
          cx={11}
          cy={11}
          r={RING_RADIUS}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${dashLen} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: isHigh ? 600 : 500,
          fontSize: 9,
          color: isHigh ? COLOR_HIGH : pct >= 60 ? "#E6E6E8" : "#B0B0B6",
          lineHeight: 1,
          position: "relative",
          zIndex: 1,
        }}
      >
        {pct}
      </span>
      {open && (
        <div
          data-testid="context-ring-popover"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: 30,
            right: -8,
            minWidth: 200,
            background: "#1A1A1F",
            border: "1px solid #2E2E34",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            padding: 0,
            zIndex: 50,
            cursor: "default",
          }}
        >
          <div
            style={{
              padding: "10px 14px 8px",
              borderBottom: "1px solid #26262C",
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 500,
              fontSize: 10,
              letterSpacing: "0.14em",
              color: "#5A5A60",
              textTransform: "uppercase",
            }}
          >
            session usage
          </div>
          <PopoverRow label="input" value={totalInputTokens} />
          <PopoverRow label="output" value={totalOutputTokens} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 14px 10px",
              borderTop: "1px solid #26262C",
            }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                letterSpacing: "0.1em",
                color: "#6E767D",
                textTransform: "uppercase",
              }}
            >
              total
            </span>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontWeight: 600,
                fontSize: 13,
                color: "#E6E6E8",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {numberFormat.format(totalSum)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function PopoverRow({ label, value }: { label: string; value: number }) {
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
          color: "#8A8A92",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontWeight: 500,
          fontSize: 12,
          color: "#E6E6E8",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {numberFormat.format(value)}
      </span>
    </div>
  );
}
