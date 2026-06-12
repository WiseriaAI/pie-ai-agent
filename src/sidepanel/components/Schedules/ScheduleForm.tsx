// src/sidepanel/components/Schedules/ScheduleForm.tsx
//
// Task 9.2 — create / edit form for a Schedule. Functional UI aligned with the
// slate token system (mirrors SkillForm / InstanceForm). Validation is local
// (title/prompt required, interval >= MIN_INTERVAL_MINUTES, startUrl not
// restricted); the actual
// mutation goes through onSubmit → SW write channel, whose { ok, error } is
// surfaced inline.

import { useState } from "react";
import type { DecryptedInstance } from "@/lib/instances";
import type { ScheduleRecord } from "@/lib/schedules/types";
import { MIN_INTERVAL_MINUTES } from "@/lib/schedules/types";
import { isRestrictedScheduleUrl } from "@/lib/schedules/url-guard";
import { useT } from "@/lib/i18n/use-t";
import type {
  ScheduleCreatePayload,
  ScheduleUpdatePayload,
  ScheduleActionResponse,
} from "@/lib/schedules/panel-actions";

interface Props {
  instances: DecryptedInstance[];
  activeInstanceId: string | null;
  /** When set, the form edits this schedule; otherwise it creates. */
  editing?: ScheduleRecord;
  onSubmit: (
    payload: ScheduleCreatePayload | ScheduleUpdatePayload,
  ) => Promise<ScheduleActionResponse>;
  onCancel: () => void;
}

interface FormState {
  title: string;
  prompt: string;
  startAtLocal: string; // datetime-local string ("" = run immediately)
  intervalMinutes: string;
  maxRuns: string;
  startUrl: string;
  maxStepsPerRun: string;
  maxRunMs: string;
  instanceId: string;
}

/** Format an epoch-ms into a value suitable for <input type="datetime-local">. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initialState(editing: ScheduleRecord | undefined, activeInstanceId: string | null, instances: DecryptedInstance[]): FormState {
  const fallbackInstance = activeInstanceId ?? instances[0]?.id ?? "";
  if (!editing) {
    return {
      title: "",
      prompt: "",
      startAtLocal: "",
      intervalMinutes: "",
      maxRuns: "",
      startUrl: "",
      maxStepsPerRun: "",
      maxRunMs: "",
      instanceId: fallbackInstance,
    };
  }
  return {
    title: editing.title,
    prompt: editing.prompt,
    startAtLocal: editing.spec.startAt != null ? toLocalInput(editing.spec.startAt) : "",
    intervalMinutes: editing.spec.intervalMinutes != null ? String(editing.spec.intervalMinutes) : "",
    maxRuns: editing.spec.maxRuns != null ? String(editing.spec.maxRuns) : "",
    startUrl: editing.startUrl ?? "",
    maxStepsPerRun: editing.maxStepsPerRun != null ? String(editing.maxStepsPerRun) : "",
    maxRunMs: editing.maxRunMs != null ? String(editing.maxRunMs) : "",
    instanceId: editing.instanceId,
  };
}

export default function ScheduleForm({ instances, activeInstanceId, editing, onSubmit, onCancel }: Props) {
  const t = useT();
  const isEdit = !!editing;
  const [form, setForm] = useState<FormState>(() => initialState(editing, activeInstanceId, instances));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function validate(): string | null {
    if (!form.title.trim()) return t("schedules.errTitleRequired");
    if (!form.prompt.trim()) return t("schedules.errPromptRequired");
    if (form.intervalMinutes.trim()) {
      const n = Number(form.intervalMinutes);
      if (!Number.isFinite(n) || n < MIN_INTERVAL_MINUTES) {
        return t("schedules.errIntervalMin", { min: MIN_INTERVAL_MINUTES });
      }
    }
    if (form.maxRuns.trim()) {
      const n = Number(form.maxRuns);
      if (!Number.isFinite(n) || n < 1) return t("schedules.errRunsMin");
    }
    if (form.startUrl.trim() && isRestrictedScheduleUrl(form.startUrl.trim())) {
      return t("schedules.errStartUrlRestricted");
    }
    if (!form.instanceId) return t("schedules.errSelectConfig");
    return null;
  }

  function buildSpec() {
    const spec: { startAt?: number; intervalMinutes?: number; maxRuns?: number } = {};
    if (form.startAtLocal.trim()) {
      const ms = new Date(form.startAtLocal).getTime();
      if (Number.isFinite(ms)) spec.startAt = ms;
    }
    if (form.intervalMinutes.trim()) spec.intervalMinutes = Number(form.intervalMinutes);
    if (form.maxRuns.trim()) spec.maxRuns = Number(form.maxRuns);
    return spec;
  }

  async function handleSubmit() {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const spec = buildSpec();
      const common = {
        title: form.title.trim(),
        prompt: form.prompt.trim(),
        spec,
        startUrl: form.startUrl.trim() || undefined,
        maxStepsPerRun: form.maxStepsPerRun.trim() ? Number(form.maxStepsPerRun) : undefined,
        maxRunMs: form.maxRunMs.trim() ? Number(form.maxRunMs) : undefined,
      };
      const payload: ScheduleCreatePayload | ScheduleUpdatePayload = isEdit
        ? { id: editing!.id, ...common, startUrl: form.startUrl.trim() }
        : { instanceId: form.instanceId, ...common };
      const res = await onSubmit(payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // success — parent closes the form
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">
          {isEdit ? t("schedules.formEditTitle") : t("schedules.formNewTitle")}
        </span>
        <button
          onClick={onCancel}
          className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
        >
          {t("schedules.cancel")}
        </button>
      </div>

      {error && (
        <div className="rounded border border-warning-line bg-warning-tint px-2.5 py-1.5 text-[12px] text-warning">
          {error}
        </div>
      )}

      <Field label={t("schedules.fieldTitle")} htmlFor="sched-title">
        <input
          id="sched-title"
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder={t("schedules.fieldTitlePlaceholder")}
        />
      </Field>

      <Field label={t("schedules.fieldPrompt")} htmlFor="sched-prompt">
        <textarea
          id="sched-prompt"
          value={form.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          rows={4}
          className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] leading-[18px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder={t("schedules.fieldPromptPlaceholder")}
        />
      </Field>

      {!isEdit && (
        <Field label={t("schedules.fieldConfig")} htmlFor="sched-instance">
          <select
            id="sched-instance"
            value={form.instanceId}
            onChange={(e) => set("instanceId", e.target.value)}
            className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 focus:border-accent-line"
          >
            {instances.length === 0 && <option value="">{t("schedules.configNone")}</option>}
            {instances.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {inst.nickname} · {inst.provider}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="grid grid-cols-3 gap-2">
        <Field label={t("schedules.fieldStartAt")} htmlFor="sched-startat" hint={t("schedules.hintOptional")}>
          <input
            id="sched-startat"
            type="datetime-local"
            value={form.startAtLocal}
            onChange={(e) => set("startAtLocal", e.target.value)}
            className="w-full rounded-[10px] border border-line bg-field px-2 py-2 text-[11px] text-fg-1 focus:border-accent-line"
          />
        </Field>
        <Field label={t("schedules.fieldInterval")} htmlFor="sched-interval" hint={`≥${MIN_INTERVAL_MINUTES}`}>
          <input
            id="sched-interval"
            type="number"
            min={MIN_INTERVAL_MINUTES}
            value={form.intervalMinutes}
            onChange={(e) => set("intervalMinutes", e.target.value)}
            className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
            placeholder={t("schedules.placeholderOnce")}
          />
        </Field>
        <Field label={t("schedules.fieldRuns")} htmlFor="sched-maxruns" hint={t("schedules.hintInfinityBlank")}>
          <input
            id="sched-maxruns"
            type="number"
            min={1}
            value={form.maxRuns}
            onChange={(e) => set("maxRuns", e.target.value)}
            className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
            placeholder="∞"
          />
        </Field>
      </div>

      <Field label={t("schedules.fieldStartUrl")} htmlFor="sched-starturl" hint={t("schedules.startUrlHint")}>
        <input
          id="sched-starturl"
          value={form.startUrl}
          onChange={(e) => set("startUrl", e.target.value)}
          className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder="https://example.com"
        />
      </Field>

      <details className="text-[12px] text-fg-2">
        <summary className="cursor-pointer select-none text-[12px] text-fg-3 hover:text-fg-2">
          {t("schedules.advancedSummary")}
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field label={t("schedules.fieldMaxSteps")} htmlFor="sched-maxsteps" hint={t("schedules.hintOptional")}>
            <input
              id="sched-maxsteps"
              type="number"
              min={1}
              value={form.maxStepsPerRun}
              onChange={(e) => set("maxStepsPerRun", e.target.value)}
              className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
              placeholder={t("schedules.placeholderNone")}
            />
          </Field>
          <Field label={t("schedules.fieldMaxMs")} htmlFor="sched-maxms" hint={t("schedules.hintOptional")}>
            <input
              id="sched-maxms"
              type="number"
              min={1000}
              value={form.maxRunMs}
              onChange={(e) => set("maxRunMs", e.target.value)}
              className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
              placeholder={t("schedules.placeholderNone")}
            />
          </Field>
        </div>
      </details>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-[10px] border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:text-fg-1"
        >
          {t("schedules.cancel")}
        </button>
        <button
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="rounded-[10px] bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas hover:opacity-90 disabled:opacity-50"
        >
          {isEdit ? t("schedules.save") : t("schedules.create")}
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={htmlFor} className="text-[12px] font-medium text-fg-2">
          {label}
        </label>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
