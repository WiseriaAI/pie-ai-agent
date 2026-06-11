// src/sidepanel/components/Schedules/SchedulesPanel.tsx
//
// Task 9.2/9.3 — Schedules management page. READS straight from IDB
// (listSchedules) and stays live via the store-bus "schedules" event. All
// MUTATIONS route through the SW write channel (panel-actions → SW
// handleScheduleAction → shared schedule-ops), never touching scheduler/alarms
// from the panel. Row actions: toggle enabled, run now, edit, delete, expand
// run history.

import { useCallback, useEffect, useState } from "react";
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
import { listInstances, getActiveInstance } from "@/lib/instances";
import type { DecryptedInstance } from "@/lib/instances";
import type { ScheduleRecord } from "@/lib/schedules/types";
import ScheduleForm from "./ScheduleForm";
import ScheduleRunHistory from "./ScheduleRunHistory";

interface Props {
  /** Open a session by id (wired in App → session.setActive + switch to chat). */
  onOpenSession: (sessionId: string) => void;
}

const STATUS_STYLE: Record<ScheduleRecord["status"], string> = {
  active: "text-accent border-accent-line bg-accent-tint",
  paused: "text-warning border-warning-line bg-warning-tint",
  completed: "text-fg-3 border-line bg-field",
};

function fmtNextRun(ms: number | undefined, enabled: boolean, status: ScheduleRecord["status"]): string {
  if (!enabled) return "disabled";
  if (status !== "active") return "—";
  if (ms == null) return "—";
  const d = new Date(ms);
  try {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return d.toISOString();
  }
}

function scheduleSummary(rec: ScheduleRecord): string {
  const parts: string[] = [];
  if (rec.spec.intervalMinutes != null) {
    parts.push(`every ${rec.spec.intervalMinutes}m`);
  } else {
    parts.push("once");
  }
  if (rec.spec.maxRuns != null) {
    parts.push(`${rec.runCount}/${rec.spec.maxRuns} runs`);
  } else {
    parts.push(`${rec.runCount} runs`);
  }
  return parts.join(" · ");
}

export default function SchedulesPanel({ onOpenSession }: Props) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    void getActiveInstance().then(setActiveInstanceId);
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
        <span className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">Schedules</span>
        {!showCreate && !editingId && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex h-8 items-center gap-2 rounded-[10px] border border-line bg-transparent px-3 text-[12px] text-accent hover:bg-field"
          >
            New schedule
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="flex flex-col gap-4">
          {showCreate && (
            <ScheduleForm
              instances={instances}
              activeInstanceId={activeInstanceId}
              onSubmit={handleCreate}
              onCancel={() => setShowCreate(false)}
            />
          )}

          {editing && (
            <ScheduleForm
              instances={instances}
              activeInstanceId={activeInstanceId}
              editing={editing}
              onSubmit={handleEditSave}
              onCancel={() => setEditingId(null)}
            />
          )}

          {!loading && schedules.length === 0 && !showCreate && (
            <div className="rounded-[10px] border border-line bg-surface px-3 py-4 text-[12px] leading-[18px] text-fg-2">
              No schedules yet. Create one to have the agent run a task automatically on a recurring basis.
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
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      <div className="flex flex-col gap-2 px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <button
            data-testid={`toggle-${rec.id}`}
            onClick={onToggle}
            role="switch"
            aria-checked={rec.enabled}
            aria-label={rec.enabled ? `Disable ${rec.title}` : `Enable ${rec.title}`}
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
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg-1" title={rec.title}>
            {rec.title}
          </span>
          <span
            className={`flex-shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] ${STATUS_STYLE[rec.status]}`}
          >
            {rec.status}
          </span>
        </div>

        <div className="flex items-center gap-2 pl-[46px] font-mono text-[10px] text-fg-3">
          <span>{scheduleSummary(rec)}</span>
          <span>·</span>
          <span>next {fmtNextRun(rec.nextRunAt, rec.enabled, rec.status)}</span>
        </div>

        <div className="flex items-center gap-2 pl-[46px] pt-1">
          <button
            data-testid={`runnow-${rec.id}`}
            onClick={onRunNow}
            className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            Run now
          </button>
          <button
            onClick={onEdit}
            className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            Edit
          </button>
          <button
            onClick={onToggleExpand}
            className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            {expanded ? "Hide runs" : "Runs"}
          </button>
          <div className="flex-1" />
          {confirmDelete ? (
            <>
              <button
                data-testid={`delete-confirm-${rec.id}`}
                onClick={onDelete}
                className="rounded-[10px] border border-warning-line bg-transparent px-2.5 py-1 text-[11px] text-warning hover:bg-warning-tint"
              >
                Confirm
              </button>
              <button
                onClick={onCancelDelete}
                className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              data-testid={`delete-${rec.id}`}
              onClick={onAskDelete}
              className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-3 hover:border-warning-line hover:text-warning"
            >
              Delete
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
