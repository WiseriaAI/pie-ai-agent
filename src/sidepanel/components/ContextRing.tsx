import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { DropdownPanel } from "./ui/DropdownPanel";

export interface ContextRingProps {
  lastInputTokens: number | undefined;
  lastOutputTokens: number | undefined;
  totalInputTokens: number;
  totalOutputTokens: number;
  maxContextTokens: number | undefined;
  /** Last call's total prompt tokens — the ring's numerator (current context size). */
  lastPromptTotalTokens?: number;
  /** Last call's context composition, already scaled to sum to
   *  `lastPromptTotalTokens`. Absent on old sessions / providers with no usage. */
  lastBreakdown?: { system: number; tools: number; messages: number };
  /** Session-cumulative cached / total prompt tokens. The hit ratio is
   *  session-wide on purpose: a single step swings from ~50% (page read) to
   *  100% (pure reasoning), which reads as breakage rather than signal. */
  totalCachedTokens?: number;
  totalPromptTokens?: number;
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

/** 24_800 → "24.8K",1_204_880 → "1.2M"。四位数以下原样 —— 缩写只为省宽度,
 *  "0.9K" 比 "900" 更难读。小数点分隔符走 locale(pt-BR 得到 "1,2M")。 */
function fmtTokens(n: number, nf: Intl.NumberFormat): string {
  if (n >= 1_000_000) return `${nf.format(Math.round(n / 100_000) / 10)}M`;
  if (n >= 1_000) return `${nf.format(Math.round(n / 100) / 10)}K`;
  return nf.format(n);
}

export default function ContextRing(props: ContextRingProps) {
  const {
    lastInputTokens,
    lastOutputTokens: _lastOutputTokens, // reserved for future use; silence unused warning
    totalInputTokens,
    totalOutputTokens,
    maxContextTokens,
    lastPromptTotalTokens,
    lastBreakdown,
    totalCachedTokens,
    totalPromptTokens,
  } = props;
  void _lastOutputTokens;

  const { locale, t } = useI18n();
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 环的分子必须是「本次调用真实处理的 prompt 总量」。Anthropic-wire 家族
  // (anthropic / deepseek / minimax / mimo / stepfun) 的 input_tokens **排除**
  // cache_read 与 cache_creation —— 命中 90% 时它只剩真实上下文的 10%,直接拿它
  // 算占比会严重低估。promptTotalTokens 是 provider 报了缓存计数时才有的全量值;
  // 没报时回落 inputTokens(openai-compat / openai / gemini 的 input 本就含缓存,
  // 两者相等)。
  const contextTokens = lastPromptTotalTokens ?? lastInputTokens;

  const shouldRender =
    contextTokens != null &&
    contextTokens > 0 &&
    maxContextTokens != null &&
    maxContextTokens > 0;

  // Session-wide cache hit ratio. Rendered only when the provider actually
  // reported cache counters — never a fabricated 0%.
  const cacheHitPct =
    totalCachedTokens != null && totalPromptTokens != null && totalPromptTokens > 0
      ? Math.min(100, Math.round((totalCachedTokens / totalPromptTokens) * 100))
      : null;

  // Compute pct unconditionally so hook order is stable across renders.
  const pct = shouldRender
    ? Math.min(100, Math.round((contextTokens! / maxContextTokens!) * 100))
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
  const tooltipText =
    t("chat.contextRing.lastCall", {
      used: fmtTokens(contextTokens!, numberFormat),
      max: fmtTokens(maxContextTokens!, numberFormat),
      pct: numberFormat.format(pct),
    }) +
    (cacheHitPct != null
      ? ` · ${t("chat.contextRing.cacheHit")} ${numberFormat.format(cacheHitPct)}%`
      : "");

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
        {/* Cache hit ratio of the last call, inside the ring. Tiny by design —
            the number is a glanceable health signal; details live in the
            tooltip + popover. Hidden when the provider reports no cache info. */}
        {cacheHitPct != null && (
          <text
            data-testid="context-ring-cache-pct"
            x={RING_CENTER}
            y={RING_CENTER}
            textAnchor="middle"
            dominantBaseline="central"
            fill="var(--c-fg-3)"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 6,
              letterSpacing: "-0.02em",
            }}
          >
            {cacheHitPct}
          </text>
        )}
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
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 12,
              padding: "10px 14px 8px",
              borderBottom: "1px solid var(--c-line)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 500,
                fontSize: 10,
                letterSpacing: "0.14em",
                color: "var(--c-fg-3)",
                textTransform: "uppercase",
              }}
            >
              {t("chat.contextRing.contextTitle")}
              {/* 上下文在任务结束时会缩水,用户看到数字掉下去会以为是 bug。原生
                  title 就够:不抢焦点、不占布局、长按/hover 都能出。 */}
              <span
                data-testid="context-ring-help"
                title={t("chat.contextRing.help")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  border: "1px solid var(--c-line)",
                  fontSize: 8,
                  lineHeight: 1,
                  letterSpacing: 0,
                  cursor: "help",
                }}
              >
                ?
              </span>
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
              {fmtTokens(contextTokens!, numberFormat)} / {fmtTokens(maxContextTokens!, numberFormat)}
            </span>
          </div>
          {/* Only the system-prompt slice is broken out. tools / messages / free
              were dropped as noise — they are local estimates, and the number
              that actually matters is the total against the window. */}
          {lastBreakdown && (
            <PopoverRow
              label={t("chat.contextRing.system")}
              value={fmtTokens(lastBreakdown.system, numberFormat)}
            />
          )}
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
              {t("chat.contextRing.sessionTotal")}
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
              {fmtTokens(totalSum, numberFormat)}
            </span>
          </div>
          {cacheHitPct != null && (
            <PopoverRow
              label={t("chat.contextRing.cacheHit")}
              value={`${numberFormat.format(cacheHitPct)}%`}
            />
          )}
        </div>
      </DropdownPanel>
    </div>
  );
}

function PopoverRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
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
        {value}
      </span>
    </div>
  );
}
