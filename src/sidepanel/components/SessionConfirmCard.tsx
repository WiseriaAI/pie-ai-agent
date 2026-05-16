import { useT } from "@/lib/i18n";
import type { PinnedTabDriftPayload } from "@/types";

/**
 * M1-U5 — session-level confirm card for the R11 drift gate.
 *
 * Renders a single 'Discard task' button — the only safe action when
 * the pinned tab is gone or has navigated to a different origin.
 * Plan K-5 / R11: informed-approval, not silent abort. Two reason
 * variants distinguish "tab closed" vs "origin changed" so the user
 * understands what happened, but the affordance is identical.
 */

interface Props {
  kind: "pinned-tab-drift" | "paused-resume";
  payload: unknown;
  resolved?: "discarded";
  onDiscard: () => void;
}

export default function SessionConfirmCard({
  kind,
  payload,
  resolved,
  onDiscard,
}: Props) {
  const t = useT();
  if (kind === "pinned-tab-drift") {
    return (
      <DriftCard
        payload={payload as PinnedTabDriftPayload}
        resolved={resolved}
        onDiscard={onDiscard}
      />
    );
  }
  // paused-resume kind reserved for future use; render a minimal
  // fallback so an SW emit doesn't crash the panel.
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-fg-2">
      {t("sessions.sessionPausedMsg")}
    </div>
  );
}

function DriftCard({
  payload,
  resolved,
  onDiscard,
}: {
  payload: PinnedTabDriftPayload;
  resolved?: "discarded";
  onDiscard: () => void;
}) {
  const t = useT();
  const isDiscarded = resolved === "discarded";
  const reasonHeadline =
    payload.reason === "tab-closed"
      ? t("sessions.pinnedTabClosed")
      : t("sessions.pageNavigatedAway");

  const driftParts = t("sessions.driftExplanation").split(". ");
  const driftFirst = driftParts[0] ?? "";
  const driftSecond = driftParts[1] ?? "";

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-4 py-3.5 text-[13px]"
      role="dialog"
      aria-labelledby="session-drift-title"
    >
      <div className="flex flex-col gap-1.5">
        <span className="caps text-warning" id="session-drift-title">
          {reasonHeadline}
        </span>
        <p className="leading-5 text-fg-1">
          {driftFirst}.{" "}
          {payload.reason === "tab-closed"
            ? t("sessions.driftExplanationTabClosed")
            : t("sessions.driftExplanationNavAway")}{" "}
          {driftSecond}
        </p>
      </div>

      <dl className="flex flex-col gap-1 font-mono text-[11px] text-fg-2">
        <Row label={t("sessions.originalGoal")} value={payload.originalTask || t("sessions.goalEmpty")} />
        <Row
          label={t("sessions.lastPinnedTab")}
          value={payload.lastPinnedTabTitle || t("sessions.noTitle")}
        />
        <Row label={t("sessions.pinnedOrigin")} value={payload.pinnedOrigin} />
        {payload.reason === "origin-changed" && payload.currentOrigin && (
          <Row label={t("sessions.nowShows")} value={payload.currentOrigin} />
        )}
        <Row
          label={t("sessions.stepsCompleted")}
          value={String(payload.lastStepIndex)}
        />
      </dl>

      <button
        onClick={onDiscard}
        disabled={isDiscarded}
        className="self-start rounded border border-warning-line bg-transparent px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-warning hover:bg-warning-tint disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t("sessions.discardTaskAria")}
      >
        {isDiscarded ? t("sessions.discarded") : t("sessions.discardTask")}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[140px] flex-shrink-0 text-fg-3">{label}</dt>
      <dd className="flex-1 truncate text-fg-1">{value}</dd>
    </div>
  );
}
