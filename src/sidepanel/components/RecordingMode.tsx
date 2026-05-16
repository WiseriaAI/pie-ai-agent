import type { CSSProperties } from "react";
import type { RecordedAction } from "@/lib/recording/types";
import { useT } from "@/lib/i18n";

/**
 * Recording v1 Booth — full-panel view shown while a recording session is
 * live. Replaces the chat body + composer with:
 *
 *   1. Vital Bar — large mono step counter + magenta RECORDING label + halo
 *      pulse. No timer / no waveform: this is DOM-event capture, not audio.
 *   2. Sequence — one row per RecordedAction: index • type chip • label •
 *      optional REDACTED / UNSTABLE meta chip.
 *   3. Footer Recording Bar — Cancel + Finish (replaces the chat composer).
 *
 * Visual tokens come exclusively from sidepanel/index.css `--c-*` tokens to
 * stay locked to the Pie design system.
 */

interface RecordingModeProps {
  active: boolean;
  actions: RecordedAction[];
  lastAbortReason:
    | "sw-restart"
    | "session-switched"
    | "panel-disconnect"
    | "tab-closed"
    | "csp-blocked"
    | "user-discard"
    | null;
  onFinish: () => void;
  onDiscard: () => void;
}

export default function RecordingMode({
  active,
  actions,
  lastAbortReason,
  onFinish,
  onDiscard,
}: RecordingModeProps) {
  const t = useT();

  if (!active && lastAbortReason) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          padding: "32px 24px",
          gap: 12,
          color: "var(--c-fg-2)",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.10em",
            color: "var(--c-warning)",
          }}
        >
          {t("recording.aborted")}
        </div>
        <div style={{ fontSize: 13, color: "var(--c-fg-2)" }}>
          {t("recording.reason")}{" "}
          <code style={{ fontFamily: "'JetBrains Mono', monospace" }}>{lastAbortReason}</code>
        </div>
        <div style={{ fontSize: 12, color: "var(--c-fg-3)" }}>
          {t("recording.startNew")}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        background: "var(--c-canvas)",
      }}
    >
      {/* ── Vital Bar ───────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "22px 16px",
          borderBottom: "1px solid var(--c-line)",
          flexShrink: 0,
        }}
      >
        <PulseDot />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 28,
                fontWeight: 500,
                lineHeight: "32px",
                color: "var(--c-fg-1)",
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.01em",
              }}
            >
              {actions.length}
            </span>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "0.10em",
                color: "var(--c-fg-3)",
              }}
            >
              {actions.length === 1 ? t("recording.step") : t("recording.steps")}
            </span>
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.10em",
              color: "var(--c-pending)",
            }}
          >
            {t("recording.recording")}
          </div>
        </div>
      </div>

      {/* ── Sequence ───────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px 6px",
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: "0.10em",
              color: "var(--c-fg-3)",
            }}
          >
            {t("recording.sequence")}
          </span>
          <span style={{ flex: 1, height: 1, background: "var(--c-line)" }} />
        </div>

        {actions.map((action, idx) => (
          <SequenceRow key={`${idx}-${action.timestamp}`} index={idx + 1} action={action} />
        ))}

        {/* Awaiting placeholder — capture is live; next action lands here */}
        <AwaitingRow nextIndex={actions.length + 1} />
      </div>

      {/* ── Footer Recording Bar (replaces composer) ───────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: "14px 16px 16px",
          borderTop: "1px solid var(--c-line)",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 12px 12px 16px",
            background: "var(--c-surface)",
            border: "1px solid var(--c-pending)",
            borderRadius: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            <SmallPulseDot />
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.08em",
                color: "var(--c-fg-1)",
              }}
            >
              {t("recording.recording")}
              <span style={{ color: "var(--c-fg-3)", fontWeight: 400, padding: "0 8px" }}>·</span>
              <span style={{ color: "var(--c-accent)", fontVariantNumeric: "tabular-nums" }}>
                {actions.length} {actions.length === 1 ? t("recording.step") : t("recording.steps")}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={onDiscard}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "5px 10px",
                background: "transparent",
                border: "1px solid var(--c-line)",
                borderRadius: 8,
                height: 28,
                fontFamily: "Inter, sans-serif",
                fontSize: 12,
                fontWeight: 500,
                color: "var(--c-fg-2)",
                cursor: "pointer",
              }}
            >
              {t("recording.cancel")}
            </button>
            <button
              type="button"
              onClick={onFinish}
              disabled={actions.length === 0}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "5px 12px",
                background: actions.length === 0 ? "var(--c-field)" : "var(--c-accent)",
                border: `1px solid ${actions.length === 0 ? "var(--c-line)" : "var(--c-accent)"}`,
                borderRadius: 8,
                height: 28,
                fontFamily: "Inter, sans-serif",
                fontSize: 12,
                fontWeight: 600,
                color: actions.length === 0 ? "var(--c-fg-3)" : "var(--c-canvas)",
                cursor: actions.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              {t("recording.finish")}
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  opacity: actions.length === 0 ? 1 : 0.55,
                }}
              >
                ⏎
              </span>
            </button>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "var(--c-fg-3)",
            }}
          >
            {t("recording.esc")}
          </span>
          <span
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: 11,
              color: "var(--c-fg-3)",
            }}
          >
            {t("recording.escHint")}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Subcomponents ─────────────────────────────────────────────

function PulseDot() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        flexShrink: 0,
        position: "relative",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          background: "var(--c-pending)",
          borderRadius: "50%",
          // halo via two layered box-shadows; no animation (would burn battery)
          boxShadow:
            "0 0 0 5px rgba(194, 96, 190, 0.20), 0 0 0 12px rgba(194, 96, 190, 0.06)",
        }}
      />
    </div>
  );
}

function SmallPulseDot() {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        background: "var(--c-pending)",
        borderRadius: "50%",
        boxShadow: "0 0 0 4px rgba(194, 96, 190, 0.18)",
        flexShrink: 0,
      }}
    />
  );
}

function SequenceRow({ index, action }: { index: number; action: RecordedAction }) {
  const tLoc = useT();
  const typeLabels: Record<string, string> = {
    click: tLoc("recording.typeLabels.click"),
    type: tLoc("recording.typeLabels.type"),
    select: tLoc("recording.typeLabels.select"),
    scroll: tLoc("recording.typeLabels.scroll"),
    navigate: tLoc("recording.typeLabels.nav"),
    submit: tLoc("recording.typeLabels.submit"),
  };
  const typeLabel = typeLabels[action.type];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "9px 16px",
      }}
    >
      <span
        style={{
          width: 22,
          flexShrink: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--c-fg-3)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {String(index).padStart(2, "0")}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 56,
          flexShrink: 0,
          padding: "3px 0",
          border: "1px solid var(--c-line)",
          borderRadius: 4,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          color: "var(--c-accent)",
        }}
      >
        {typeLabel}
      </span>
      <SequenceLabel action={action} />
      {action.redacted && <MetaChip kind="redacted" />}
      {action.unstable && <MetaChip kind="unstable" />}
    </div>
  );
}

function SequenceLabel({ action }: { action: RecordedAction }) {
  const baseStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "Inter, sans-serif",
    fontSize: 13,
    lineHeight: "18px",
    color: "var(--c-fg-1)",
  };
  if (action.type === "navigate") {
    return (
      <span style={baseStyle}>
        <span style={{ color: "var(--c-fg-3)" }}>→</span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: "var(--c-fg-2)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {action.url}
        </span>
      </span>
    );
  }
  if ((action.type === "type" || action.type === "select") && action.value !== undefined) {
    return (
      <span style={baseStyle}>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 140,
          }}
        >
          {action.label}
        </span>
        <span style={{ color: "var(--c-fg-3)", flexShrink: 0 }}>→</span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: action.redacted ? "var(--c-warning)" : "var(--c-fg-2)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
          }}
        >
          {action.redacted ? `{{${action.placeholderName}}}` : action.value}
        </span>
      </span>
    );
  }
  return (
    <span
      style={{
        ...baseStyle,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        display: "block",
      }}
    >
      {action.label}
    </span>
  );
}

function MetaChip({ kind }: { kind: "redacted" | "unstable" }) {
  const tLoc = useT();
  const label = kind === "redacted" ? tLoc("recording.metaRedacted") : tLoc("recording.metaUnstable");
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        padding: "3px 6px",
        border: "1px solid var(--c-warning)",
        borderRadius: 4,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.08em",
        color: "var(--c-warning)",
      }}
    >
      {kind === "redacted" && (
        <span
          style={{
            width: 4,
            height: 4,
            background: "var(--c-warning)",
            borderRadius: "50%",
          }}
        />
      )}
      {label}
    </span>
  );
}

function AwaitingRow({ nextIndex }: { nextIndex: number }) {
  const tLoc = useT();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "9px 16px",
      }}
    >
      <span
        style={{
          width: 22,
          flexShrink: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--c-line)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {String(nextIndex).padStart(2, "0")}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px",
          border: "1px dashed var(--c-line)",
          borderRadius: 4,
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            background: "var(--c-fg-3)",
            borderRadius: "50%",
          }}
        />
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.08em",
            color: "var(--c-fg-3)",
          }}
        >
          {tLoc("recording.awaiting")}
        </span>
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "Inter, sans-serif",
          fontSize: 12,
          fontStyle: "italic",
          color: "var(--c-fg-3)",
        }}
      >
        {tLoc("recording.awaitingHint")}
      </span>
    </div>
  );
}
