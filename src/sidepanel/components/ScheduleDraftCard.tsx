import { useState, useEffect } from "react";
import type { DecryptedInstance } from "@/lib/instances";
import { useT } from "@/lib/i18n";
import ModelPicker from "./ModelPicker";
import type { ScheduleDraftPayload } from "@/lib/agent/tools/schedule-meta";
import { m, AnimatePresence, DURATION, EASE_STANDARD } from "./ui/motion";

interface Props {
  payload: ScheduleDraftPayload;
  instances: DecryptedInstance[];
  onSubmit: (instanceId: string, model: string) => void;
  onCancel: () => void;
}

const ClockIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const RepeatIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

const CheckIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </svg>
);

/**
 * #184 — inline schedule-draft card rendered in the assistant message stream.
 * Replaces the old floating-card pattern. Three internal phases:
 *   "form"    — model picker + Create (disabled until a model is selected)
 *   "created" — checkmark header, static model row, no action buttons;
 *               auto-resolves via onSubmit after a ~1s dwell so the user sees
 *               confirmation before the card disappears.
 *
 * Animated via the project's motion primitives (m.div + AnimatePresence from
 * ./ui/motion). The AnimatePresence wrapper lives in Chat.tsx so exit animates
 * when the card unmounts.
 */
export function ScheduleDraftCard({ payload, instances, onSubmit, onCancel }: Props) {
  const t = useT();
  const [sel, setSel] = useState<{ instanceId: string; model: string } | null>(null);
  const [phase, setPhase] = useState<"form" | "created">("form");

  // After transitioning to "created", dwell for ~1s then call onSubmit.
  useEffect(() => {
    if (phase !== "created" || !sel) return;
    const id = setTimeout(() => {
      onSubmit(sel.instanceId, sel.model);
    }, 1000);
    return () => clearTimeout(id);
  }, [phase, sel, onSubmit]);

  function handleCreate() {
    if (!sel) return;
    setPhase("created");
  }

  // Resolved instance for the "created" static model row.
  const resolvedInst = sel ? instances.find((i) => i.id === sel.instanceId) ?? null : null;

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
      className="rounded-[10px] border border-line bg-surface p-3.5 flex flex-col gap-3"
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        <span className="text-accent">
          <AnimatePresence mode="wait">
            {phase === "form" ? (
              <m.span
                key="clock"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DURATION.fast, ease: EASE_STANDARD }}
                className="flex"
              >
                <ClockIcon />
              </m.span>
            ) : (
              <m.span
                key="check"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DURATION.fast, ease: EASE_STANDARD }}
                className="flex"
              >
                <CheckIcon />
              </m.span>
            )}
          </AnimatePresence>
        </span>

        <AnimatePresence mode="wait">
          {phase === "form" ? (
            <m.span
              key="label-form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DURATION.fast, ease: EASE_STANDARD }}
              className="caps text-accent"
            >
              {t("schedules.draftCardLabel")}
            </m.span>
          ) : (
            <m.span
              key="label-created"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DURATION.fast, ease: EASE_STANDARD }}
              className="caps text-accent"
            >
              {t("schedules.draftCardCreated")}
            </m.span>
          )}
        </AnimatePresence>

        <span className="ml-auto font-mono text-[12px] text-fg-2">create_schedule</span>
      </div>

      {/* Task block */}
      <div className="flex flex-col gap-[5px]">
        <div className="text-fg-1 font-semibold text-[15px] leading-[22px] tracking-[-0.005em]">
          {payload.title}
        </div>
        <div className="flex items-center gap-[7px]">
          <span className="text-fg-2 flex-shrink-0">
            <RepeatIcon />
          </span>
          <span className="text-fg-2 text-[12px] leading-[18px]">{payload.specSummary}</span>
        </div>
      </div>

      {/* Model field */}
      <div className="flex flex-col gap-[7px]">
        <span className="caps text-fg-3">{t("schedules.draftCardRunWith")}</span>
        {phase === "form" ? (
          <ModelPicker
            instances={instances}
            currentInstanceId={sel?.instanceId ?? null}
            currentModel={sel?.model ?? null}
            locked={false}
            onSelect={(instanceId, model) => setSel({ instanceId, model })}
          />
        ) : (
          /* "created" phase — static non-interactive model row */
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-deep px-2.5 py-1.5">
            <span className="font-mono text-[12px] text-fg-2">
              {resolvedInst
                ? `${resolvedInst.nickname || resolvedInst.provider} · ${sel?.model ?? ""}`
                : sel?.model ?? ""}
            </span>
          </div>
        )}
      </div>

      {/* Actions (only in "form" phase) */}
      <AnimatePresence>
        {phase === "form" && (
          <m.div
            key="actions"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast, ease: EASE_STANDARD }}
            className="flex items-center justify-end gap-2 pt-0.5"
          >
            <button
              type="button"
              onClick={onCancel}
              className="border border-line rounded-lg px-4 py-2 text-fg-2 text-[13px] font-medium"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={!sel}
              onClick={handleCreate}
              className="bg-accent-strong text-surface border border-accent-line rounded-lg px-4 py-2 text-[13px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("schedules.draftCardCreate")}
            </button>
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}
