// src/sidepanel/components/Schedules/SchedulesPanel.tsx
//
// Task 9.2/9.3 — Schedules management page. READS straight from IDB
// (listSchedules) and stays live via the store-bus "schedules" event. All
// MUTATIONS route through the SW write channel (panel-actions → SW
// handleScheduleAction → shared schedule-ops), never touching scheduler/alarms
// from the panel. Row actions: toggle enabled, run now, edit, delete, expand
// run history.

import { useCallback, useEffect, useMemo, useState } from "react";
import { listSchedules } from "@/lib/schedules/store";
import { onStoreChange } from "@/lib/store-bus";
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  toggleSchedule,
  runScheduleNow,
  type ScheduleCreatePayload,
  type ScheduleUpdatePayload,
  type ScheduleActionResponse,
} from "@/lib/schedules/panel-actions";
import { listInstances } from "@/lib/instances";
import type { DecryptedInstance } from "@/lib/instances";
import { resolveSelection } from "@/lib/model-selection-resolver";
import type { ScheduleRecord } from "@/lib/schedules/types";
import { useI18n } from "@/lib/i18n";
import ScheduleForm from "./ScheduleForm";
import ScheduleRunHistory from "./ScheduleRunHistory";

interface Props {
  /** Open a session by id (wired in App → session.setActive + switch to chat). */
  onOpenSession: (sessionId: string) => void;
  /** Delegate schedule creation to chat: jump to the chat view with a localized
   *  template prefilled in the composer (wired in App). No-op default keeps the
   *  panel usable in isolation (e.g. unit tests). */
  onCreateViaChat?: (template: string) => void;
}

type T = ReturnType<typeof useI18n>["t"];

// Filled pills so each state reads clearly at a glance (the previous 8%-tint
// chips were too faint): active = accent fill, paused = warning fill, completed
// = neutral filled. disabled (below) = dashed outline. All use high-contrast
// text-canvas on the saturated fills.
const STATUS_STYLE: Record<ScheduleRecord["status"], string> = {
  active: "border-transparent bg-accent text-canvas",
  paused: "border-transparent bg-warning text-canvas",
  completed: "border-line bg-field text-fg-2",
};

/**
 * Badge label + style. The user's off-switch wins over the lifecycle status:
 * `enabled === false` is ALWAYS a deliberate user action (auto-pause on failures
 * / instance deletion and terminal completion never touch `enabled`), so it
 * reads as DISABLED regardless of status — including a completed or paused
 * schedule the user has turned off. Dashed outline = "you turned it off".
 * When enabled, the badge reflects the lifecycle status (active / paused /
 * completed).
 */
function badgeFor(rec: ScheduleRecord, t: T): { label: string; className: string } {
  if (!rec.enabled) {
    return {
      label: t("schedules.statusDisabled"),
      className: "border-dashed border-line bg-transparent text-fg-3",
    };
  }
  const label = {
    active: t("schedules.statusActive"),
    paused: t("schedules.statusPaused"),
    completed: t("schedules.statusCompleted"),
  }[rec.status];
  return { label, className: STATUS_STYLE[rec.status] };
}

function fmtNextRun(
  ms: number | undefined,
  enabled: boolean,
  status: ScheduleRecord["status"],
  locale: string,
): string {
  if (!enabled || status !== "active" || ms == null) return "—";
  const d = new Date(ms);
  try {
    return d.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return d.toISOString();
  }
}

function scheduleSummary(rec: ScheduleRecord, t: T, numberFormat: Intl.NumberFormat): string {
  const parts: string[] = [];
  parts.push(
    rec.spec.intervalMinutes != null
      ? t("schedules.summaryEvery", { n: numberFormat.format(rec.spec.intervalMinutes) })
      : t("schedules.summaryOnce"),
  );
  parts.push(
    rec.spec.maxRuns != null
      ? t("schedules.summaryRunsCapped", {
          count: numberFormat.format(rec.runCount),
          max: numberFormat.format(rec.spec.maxRuns),
        })
      : t("schedules.summaryRuns", { count: numberFormat.format(rec.runCount) }),
  );
  return parts.join(" · ");
}

export default function SchedulesPanel({ onOpenSession, onCreateViaChat }: Props) {
  const { locale, t } = useI18n();
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // "New schedule" first offers a choice: fill the form manually, or describe
  // it in chat. showChoice gates that menu; showCreate gates the actual form.
  const [showChoice, setShowChoice] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list = await listSchedules();
    list.sort((a, b) => b.createdAt - a.createdAt);
    setSchedules(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    void listInstances().then(setInstances);
    void resolveSelection({}).then((sel) => {
      setActiveInstanceId(sel?.instanceId ?? null);
      setActiveModel(sel?.model ?? null);
    });
  }, [reload]);

  // Live refresh: SW arming/running schedules + run appends publish "schedules".
  useEffect(() => onStoreChange("schedules", () => void reload()), [reload]);

  async function handleCreate(payload: ScheduleCreatePayload | ScheduleUpdatePayload): Promise<ScheduleActionResponse> {
    const res = await createSchedule(payload as ScheduleCreatePayload);
    if (res.ok) {
      setShowCreate(false);
      await reload();
    }
    return res;
  }

  async function handleEditSave(payload: ScheduleCreatePayload | ScheduleUpdatePayload): Promise<ScheduleActionResponse> {
    const res = await updateSchedule(payload as ScheduleUpdatePayload);
    if (res.ok) {
      setEditingId(null);
      await reload();
    }
    return res;
  }

  async function handleToggle(rec: ScheduleRecord) {
    await toggleSchedule(rec.id, !rec.enabled);
    await reload();
  }

  async function handleRunNow(rec: ScheduleRecord) {
    await runScheduleNow(rec.id);
  }

  async function handleDelete(id: string) {
    await deleteSchedule(id);
    setConfirmDeleteId(null);
    if (expandedId === id) setExpandedId(null);
    await reload();
  }

  const editing = schedules.find((s) => s.id === editingId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-5">
        <span className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">
          {t("schedules.title")}
        </span>
        {!showCreate && !editingId && (
          <button
            onClick={() => setShowChoice((v) => !v)}
            className="flex h-8 items-center gap-2 rounded-[10px] border border-line bg-transparent px-3 text-[12px] text-accent hover:bg-field"
          >
            {t("schedules.newButton")}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="flex flex-col gap-4">
          {showChoice && !showCreate && !editingId && (
            <div
              data-testid="new-schedule-choice"
              className="scale-in relative flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-3"
            >
              <button
                data-testid="new-choice-close"
                aria-label={t("schedules.closeChoice")}
                onClick={() => setShowChoice(false)}
                className="absolute right-2.5 top-2.5 flex h-5 w-5 items-center justify-center rounded-[6px] text-fg-3 hover:bg-field hover:text-fg-1"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              <span className="px-0.5 pr-6 text-[12px] font-medium text-fg-2">
                {t("schedules.newChoiceTitle")}
              </span>
              <button
                data-testid="new-choice-manual"
                onClick={() => {
                  setShowChoice(false);
                  setShowCreate(true);
                }}
                className="flex flex-col gap-0.5 rounded-[10px] border border-line bg-transparent px-3 py-2.5 text-left hover:border-fg-3 hover:bg-field"
              >
                <span className="text-[13px] font-medium text-fg-1">{t("schedules.newChoiceManualLabel")}</span>
                <span className="text-[11px] leading-[15px] text-fg-3">{t("schedules.newChoiceManualHint")}</span>
              </button>
              <button
                data-testid="new-choice-chat"
                onClick={() => {
                  setShowChoice(false);
                  onCreateViaChat?.(t("schedules.chatTemplate"));
                }}
                className="flex flex-col gap-0.5 rounded-[10px] border border-line bg-transparent px-3 py-2.5 text-left hover:border-fg-3 hover:bg-field"
              >
                <span className="text-[13px] font-medium text-fg-1">{t("schedules.newChoiceChatLabel")}</span>
                <span className="text-[11px] leading-[15px] text-fg-3">{t("schedules.newChoiceChatHint")}</span>
              </button>
            </div>
          )}

          {showCreate && (
            <ScheduleForm
              instances={instances}
              activeInstanceId={activeInstanceId}
              activeModel={activeModel}
              onSubmit={handleCreate}
              onCancel={() => setShowCreate(false)}
            />
          )}

          {editing && (
            <ScheduleForm
              instances={instances}
              activeInstanceId={activeInstanceId}
              activeModel={activeModel}
              editing={editing}
              onSubmit={handleEditSave}
              onCancel={() => setEditingId(null)}
            />
          )}

          {!loading && schedules.length === 0 && !showCreate && !showChoice && (
            <div className="rounded-[10px] border border-line bg-surface px-3 py-4 text-[12px] leading-[18px] text-fg-2">
              {t("schedules.emptyState")}
            </div>
          )}

          {schedules
            .filter((s) => s.id !== editingId)
            .map((rec) => (
              <ScheduleCard
                key={rec.id}
                rec={rec}
                expanded={expandedId === rec.id}
                confirmDelete={confirmDeleteId === rec.id}
                onToggleExpand={() => setExpandedId(expandedId === rec.id ? null : rec.id)}
                onToggle={() => void handleToggle(rec)}
                onRunNow={() => void handleRunNow(rec)}
                onEdit={() => {
                  setShowCreate(false);
                  setEditingId(rec.id);
                }}
                onAskDelete={() => setConfirmDeleteId(rec.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onDelete={() => void handleDelete(rec.id)}
                onOpenSession={onOpenSession}
                locale={locale}
                numberFormat={numberFormat}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

function ScheduleCard({
  rec,
  expanded,
  confirmDelete,
  onToggleExpand,
  onToggle,
  onRunNow,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onOpenSession,
  locale,
  numberFormat,
}: {
  rec: ScheduleRecord;
  expanded: boolean;
  confirmDelete: boolean;
  onToggleExpand: () => void;
  onToggle: () => void;
  onRunNow: () => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onOpenSession: (sessionId: string) => void;
  locale: string;
  numberFormat: Intl.NumberFormat;
}) {
  const { t } = useI18n();
  const badge = badgeFor(rec, t);
  return (
    <section className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      <div className="flex flex-col gap-2 px-3.5 py-3">
        {/* Title + status badge on the left; the enable toggle on the right. */}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-fg-1" title={rec.title}>
              {rec.title}
            </span>
            <span
              className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-[0.02em] ${badge.className}`}
            >
              {badge.label}
            </span>
          </div>
          <button
            data-testid={`toggle-${rec.id}`}
            onClick={onToggle}
            role="switch"
            aria-checked={rec.enabled}
            aria-label={
              rec.enabled
                ? t("schedules.disableAria", { title: rec.title })
                : t("schedules.enableAria", { title: rec.title })
            }
            className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full border transition-colors ${
              rec.enabled ? "border-accent-line bg-accent-tint" : "border-line bg-field"
            }`}
          >
            <span
              className={`inline-block h-3 w-3 transform rounded-full transition-transform ${
                rec.enabled ? "translate-x-5 bg-accent" : "translate-x-1 bg-fg-3"
              }`}
            />
          </button>
        </div>

        {/* Summary + next-run, left-aligned. */}
        <div className="flex items-center gap-2 font-mono text-[10px] text-fg-3">
          <span>{scheduleSummary(rec, t, numberFormat)}</span>
          <span>·</span>
          <span>{t("schedules.nextPrefix")} {fmtNextRun(rec.nextRunAt, rec.enabled, rec.status, locale)}</span>
        </div>

        {/* Actions, left-aligned. */}
        <div className="flex items-center gap-2 pt-1">
          <button
            data-testid={`runnow-${rec.id}`}
            onClick={onRunNow}
            className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            {t("schedules.runNow")}
          </button>
          <button
            onClick={onEdit}
            className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            {t("schedules.edit")}
          </button>
          <button
            onClick={onToggleExpand}
            className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            {expanded ? t("schedules.hideRuns") : t("schedules.showRuns")}
          </button>
          <div className="flex-1" />
          {confirmDelete ? (
            <>
              <button
                data-testid={`delete-confirm-${rec.id}`}
                onClick={onDelete}
                className="rounded-[10px] border border-warning-line bg-transparent px-2.5 py-1 text-[11px] text-warning hover:bg-warning-tint"
              >
                {t("schedules.confirmDelete")}
              </button>
              <button
                onClick={onCancelDelete}
                className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
              >
                {t("schedules.cancel")}
              </button>
            </>
          ) : (
            <button
              data-testid={`delete-${rec.id}`}
              onClick={onAskDelete}
              className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-3 hover:border-warning-line hover:text-warning"
            >
              {t("schedules.delete")}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line bg-canvas/40">
          <ScheduleRunHistory runIds={rec.runIds} onOpenSession={onOpenSession} />
        </div>
      )}
    </section>
  );
}
