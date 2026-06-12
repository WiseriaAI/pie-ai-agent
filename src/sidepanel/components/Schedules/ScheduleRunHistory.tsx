// src/sidepanel/components/Schedules/ScheduleRunHistory.tsx
//
// Task 9.2/9.3 — per-schedule run history. Reads each ScheduleRunRecord by id
// (getRun) and lists them most-recent-first. unread runs (Task 8 — set when a
// completion notification click could not open the side panel) are highlighted.
// Clicking a run that has a sessionId opens that session (onOpenSession, wired
// in App → session.setActive) and clears its unread flag (updateRun).

import { useEffect, useState } from "react";
import { getRun, updateRun } from "@/lib/schedules/store";
import type { ScheduleRunRecord } from "@/lib/schedules/types";
import { useT } from "@/lib/i18n/use-t";

interface Props {
  runIds: string[];
  onOpenSession: (sessionId: string) => void;
}

const OUTCOME_STYLE: Record<ScheduleRunRecord["status"], string> = {
  running: "text-accent",
  success: "text-fg-2",
  failed: "text-warning",
  interrupted: "text-warning",
  skipped: "text-fg-3",
};

const RUN_STATUS_KEY: Record<ScheduleRunRecord["status"], Parameters<ReturnType<typeof useT>>[0]> = {
  running: "schedules.runStatusRunning",
  success: "schedules.runStatusSuccess",
  failed: "schedules.runStatusFailed",
  interrupted: "schedules.runStatusInterrupted",
  skipped: "schedules.runStatusSkipped",
};

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

export default function ScheduleRunHistory({ runIds, onOpenSession }: Props) {
  const t = useT();
  const [runs, setRuns] = useState<ScheduleRunRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (runIds.length === 0) {
      setRuns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const fetched = await Promise.all(runIds.map((id) => getRun(id)));
      if (cancelled) return;
      const valid = fetched.filter((r): r is ScheduleRunRecord => r != null);
      // Most recent first (runIds is appended chronologically by appendRun).
      valid.sort((a, b) => b.startedAt - a.startedAt);
      setRuns(valid);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [runIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleClick(run: ScheduleRunRecord) {
    if (!run.sessionId) return;
    onOpenSession(run.sessionId);
    if (run.unread) {
      // Optimistically clear locally + persist.
      setRuns((prev) =>
        prev.map((r) => (r.recordId === run.recordId ? { ...r, unread: false } : r)),
      );
      await updateRun(run.recordId, { unread: false });
    }
  }

  if (loading) {
    return <p className="px-3.5 py-2 text-[11px] text-fg-3">{t("schedules.loadingRuns")}</p>;
  }

  if (runs.length === 0) {
    return <p className="px-3.5 py-2 text-[11px] text-fg-3">{t("schedules.noRuns")}</p>;
  }

  return (
    <div className="flex flex-col">
      {runs.map((run) => {
        const clickable = !!run.sessionId;
        return (
          <button
            key={run.recordId}
            data-testid={`run-row-${run.recordId}`}
            data-unread={run.unread ? "true" : "false"}
            onClick={() => void handleClick(run)}
            disabled={!clickable}
            className={`flex flex-col gap-1 border-t border-line px-3.5 py-2 text-left first:border-t-0 ${
              clickable ? "hover:bg-field" : "cursor-default"
            } ${run.unread ? "bg-accent-tint" : ""}`}
          >
            <div className="flex items-center gap-2">
              {run.unread && (
                <span
                  className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent"
                  aria-label={t("schedules.unreadAria")}
                />
              )}
              <span className="font-mono text-[11px] text-fg-2">#{run.runIndex}</span>
              <span className={`text-[11px] font-medium ${OUTCOME_STYLE[run.status]}`}>
                {t(RUN_STATUS_KEY[run.status])}
              </span>
              <span className="ml-auto font-mono text-[10px] text-fg-3">{fmtTime(run.startedAt)}</span>
            </div>
            {(run.summary || run.error) && (
              <p className="text-[11px] leading-[16px] text-fg-2">{run.error ?? run.summary}</p>
            )}
          </button>
        );
      })}
    </div>
  );
}
