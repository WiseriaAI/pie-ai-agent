/**
 * 原型参考 — issue #342 录制步骤行结构化改造（不参与构建，docs/ 在 tsc/vitest
 * include 之外）。对照 src/sidepanel/components/RecordingMode.tsx 的
 * SequenceRow / SequenceLabel 替换；类型定义落库时进 src/lib/recording/types.ts。
 *
 * 展示形态【action】content：
 *   序号 · action chip（现有，已 i18n）· kind 词(fg-2) name(fg-1) [→ value]
 * 所有自然语言词均为渲染时字典查词，无句子组合 → 语法与语言解耦。
 */
import type { CSSProperties } from "react";
import { useT } from "@/lib/i18n";

// ── 类型（落库进 src/lib/recording/types.ts）─────────────────────

export type TargetKindKey =
  | "button" | "link" | "tab" | "checkbox" | "radio" | "switch"
  | "menuitem" | "option" | "input" | "textarea" | "dropdown"
  | "summary" | "element" | "editor";

export type RegionKey = "main" | "nav" | "header" | "footer" | "aside" | "other";

export interface RecordedTarget {
  kindKey: TargetKindKey;
  /** aria/text/(placeholder='..')/(name='..') 主标识，已 sanitize；括号形态语言中立 */
  name?: string;
  /** 无 name 时的兜底序号（1-based），与 regionKey 联用 */
  nth?: number;
  regionKey?: RegionKey;
  /** kindKey==="editor" 时："Monaco" | "CodeMirror" | "TinyMCE" | "editor" */
  editorEngine?: string;
}

/** RecordedAction 相关子集（label 已移除；scroll 新增 direction） */
export interface RecordedActionLike {
  type: "click" | "type" | "select" | "scroll" | "navigate" | "submit" | "keypress";
  target?: RecordedTarget;
  value?: string;
  redacted?: boolean;
  placeholderName?: string;
  checked?: boolean;
  url: string;
  direction?: "down" | "up";
  unstable?: boolean;
}

// ── 共享样式 ─────────────────────────────────────────────────────

const mono = "'JetBrains Mono', monospace";
const sans = "Inter, sans-serif";
const wrapText: CSSProperties = { whiteSpace: "normal", overflowWrap: "anywhere", minWidth: 0 };

const kindStyle: CSSProperties = {
  fontFamily: sans,
  fontSize: 12,
  color: "var(--c-fg-2)",
  flexShrink: 0,
};
const nameStyle: CSSProperties = {
  fontFamily: sans,
  fontSize: 13,
  lineHeight: "18px",
  color: "var(--c-fg-1)",
  ...wrapText,
};
const monoValueStyle: CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  color: "var(--c-fg-2)",
  ...wrapText,
};
const arrowStyle: CSSProperties = { fontFamily: sans, fontSize: 13, color: "var(--c-fg-3)", flexShrink: 0 };

// ── 行 ──────────────────────────────────────────────────────────

export function SequenceRow({ index, action }: { index: number; action: RecordedActionLike }) {
  const t = useT();
  // action chip 词条沿用现有 recording.typeLabels.*（已 i18n），此处不重复
  const typeLabels: Record<string, string> = {
    click: t("recording.typeLabels.click"),
    type: t("recording.typeLabels.type"),
    select: t("recording.typeLabels.select"),
    scroll: t("recording.typeLabels.scroll"),
    navigate: t("recording.typeLabels.nav"),
    submit: t("recording.typeLabels.submit"),
    keypress: t("recording.typeLabels.keypress"),
  };
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "9px 16px" }}>
      <span
        style={{
          width: 22,
          flexShrink: 0,
          fontFamily: mono,
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
          fontFamily: mono,
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          color: "var(--c-accent)",
        }}
      >
        {typeLabels[action.type]}
      </span>
      <SequenceContent action={action} />
      {action.redacted && <MetaChip kind="redacted" />}
      {action.unstable && <MetaChip kind="unstable" />}
    </div>
  );
}

// ── 内容（原 SequenceLabel 的替代）───────────────────────────────

function SequenceContent({ action }: { action: RecordedActionLike }) {
  const t = useT();
  const base: CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: 6,
  };

  if (action.type === "navigate") {
    return (
      <span style={base}>
        <span style={arrowStyle}>→</span>
        <span style={monoValueStyle}>{action.url}</span>
      </span>
    );
  }

  if (action.type === "scroll") {
    return (
      <span style={base}>
        <span style={monoValueStyle}>
          {action.direction === "up" ? "↑" : "↓"} ≈ {action.value}px
        </span>
      </span>
    );
  }

  if (action.type === "keypress") {
    return (
      <span style={base}>
        <span style={monoValueStyle}>{action.value}</span>
      </span>
    );
  }

  // click / type / select / submit —— kind 词 + name（或 nth 兜底）+ 可选 value/状态
  const tg = action.target;
  return (
    <span style={base}>
      {tg && (
        <span style={kindStyle}>{t(`recording.kind.${tg.kindKey}`)}</span>
      )}
      {tg?.editorEngine ? (
        <span style={nameStyle}>{tg.editorEngine}</span>
      ) : tg?.name ? (
        <span style={nameStyle}>{tg.name}</span>
      ) : tg?.nth != null ? (
        <>
          <span style={{ fontFamily: mono, fontSize: 12, color: "var(--c-fg-1)" }}>#{tg.nth}</span>
          {tg.regionKey && (
            <span style={{ fontFamily: sans, fontSize: 12, color: "var(--c-fg-3)" }}>
              · {t(`recording.region.${tg.regionKey}`)}
            </span>
          )}
        </>
      ) : null}
      {action.checked !== undefined && (
        <span
          style={{
            fontFamily: mono,
            fontSize: 12,
            color: action.checked ? "var(--c-success)" : "var(--c-fg-3)",
          }}
        >
          {action.checked ? `✓ ${t("recording.checkedOn")}` : `✗ ${t("recording.checkedOff")}`}
        </span>
      )}
      {(action.type === "type" || action.type === "select") && action.value !== undefined && (
        <>
          <span style={arrowStyle}>→</span>
          <span
            style={{
              ...monoValueStyle,
              color: action.redacted ? "var(--c-warning)" : "var(--c-fg-2)",
              flex: 1,
            }}
          >
            {action.redacted ? `{{${action.placeholderName}}}` : action.value}
          </span>
        </>
      )}
    </span>
  );
}

// ── MetaChip / AwaitingRow：与现有 RecordingMode.tsx 一致，无改动 ──
declare function MetaChip(props: { kind: "redacted" | "unstable" }): JSX.Element;
