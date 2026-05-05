import { useState, useEffect } from "react";
import type { SkillDefinition } from "@/lib/skills";
import {
  getAllSkills,
  getEnabledSkillIds,
  setSkillEnabled,
  saveSkill,
  deleteSkill,
  generateUserSkillId,
  getSkillStorageBytes,
} from "@/lib/skills";
import { ALL_KNOWN_NON_SKILL_TOOL_NAMES } from "@/lib/agent/tool-names";
import { getActiveProvider } from "@/lib/storage";
import { getProviderMeta } from "@/lib/model-router/providers/registry";

interface SkillsListProps {
  onRunSkill: (skillId: string, skillName: string) => void;
}

const PROMPT_TEMPLATE_MAX = 8 * 1024;
const SCHEMA_STRINGS_MAX = 2 * 1024;
const STORAGE_QUOTA_BYTES = 1 * 1024 * 1024;

interface SkillFormState {
  editingId?: string;
  editingCreatedAt?: number;
  editingEnabled?: boolean;
  name: string;
  description: string;
  promptTemplate: string;
  parametersText: string;
  allowedToolsText: string;
}

function emptyForm(): SkillFormState {
  return {
    name: "",
    description: "",
    promptTemplate: "",
    parametersText: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
    allowedToolsText: "scroll, wait, done, fail",
  };
}

function formFromSkill(skill: SkillDefinition): SkillFormState {
  return {
    editingId: skill.id,
    editingCreatedAt: skill.createdAt ?? 0,
    editingEnabled: skill.enabled,
    name: skill.name,
    description: skill.description,
    promptTemplate: skill.promptTemplate,
    parametersText: JSON.stringify(skill.toolSchema.parameters, null, 2),
    allowedToolsText: (skill.allowedTools ?? []).join(", "),
  };
}

function countAllStringChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countAllStringChars(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    let total = 0;
    for (const v of Object.values(value as Record<string, unknown>)) {
      total += countAllStringChars(v);
    }
    return total;
  }
  return 0;
}

interface BuiltSkillFields {
  name: string;
  description: string;
  promptTemplate: string;
  parameters: Record<string, unknown>;
  allowedTools: string[];
}

function validateAndBuild(
  form: SkillFormState,
): { ok: true; built: BuiltSkillFields } | { ok: false; error: string } {
  if (!form.name.trim()) return { ok: false, error: "Name is required" };
  if (!form.description.trim()) return { ok: false, error: "Description is required" };
  if (!form.promptTemplate.trim()) return { ok: false, error: "Prompt template is required" };
  if (form.promptTemplate.length > PROMPT_TEMPLATE_MAX) {
    return {
      ok: false,
      error: `Prompt template too long (${form.promptTemplate.length}/${PROMPT_TEMPLATE_MAX} bytes)`,
    };
  }

  let parameters: unknown;
  try {
    parameters = JSON.parse(form.parametersText);
  } catch (e) {
    return { ok: false, error: `Parameters JSON parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { ok: false, error: 'Parameters must be a JSON object (e.g. { "type": "object", ... })' };
  }
  const schemaChars = countAllStringChars(parameters);
  if (schemaChars > SCHEMA_STRINGS_MAX) {
    return {
      ok: false,
      error: `Parameters schema strings too long (${schemaChars}/${SCHEMA_STRINGS_MAX} bytes)`,
    };
  }

  const allowedTools = form.allowedToolsText
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allowedTools.length === 0) {
    return { ok: false, error: "AllowedTools must include at least one tool name (e.g. 'done', 'fail')" };
  }
  for (const t of allowedTools) {
    if (!ALL_KNOWN_NON_SKILL_TOOL_NAMES.has(t)) {
      return { ok: false, error: `Unknown tool: '${t}'. Skills cannot reference other skills.` };
    }
  }

  return {
    ok: true,
    built: {
      name: form.name.trim(),
      description: form.description.trim(),
      promptTemplate: form.promptTemplate,
      parameters: parameters as Record<string, unknown>,
      allowedTools,
    },
  };
}

function authorTag(skill: SkillDefinition): string {
  if (skill.builtIn) return "BUILT-IN";
  if (skill.author === "agent") return "AGENT";
  return "USER";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function normalizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function SkillsList({ onRunSkill }: SkillsListProps) {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [explicitDisabledIds, setExplicitDisabledIds] = useState<Set<string>>(new Set());
  const [storageBytes, setStorageBytes] = useState<number>(0);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<SkillFormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // R9 sub-path d — warn when a skill's allowedTools contains screenshot
  // tools but the current provider doesn't support vision. Loaded once on
  // mount (same pattern as Chat.tsx checkConfig) and refreshed whenever
  // chrome.storage changes (provider switch).
  const [supportsVision, setSupportsVision] = useState<boolean>(true);

  useEffect(() => {
    async function checkVision() {
      const active = await getActiveProvider();
      const meta = active ? getProviderMeta(active) : undefined;
      setSupportsVision(meta?.supportsVision ?? true);
    }
    checkVision();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(changes).some((k) => k === "active_provider" || k.startsWith("provider_"))) {
        checkVision();
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    loadSkills();
  }, []);

  async function loadSkills() {
    const [all, ids, bytes] = await Promise.all([
      getAllSkills(),
      getEnabledSkillIds(),
      getSkillStorageBytes(),
    ]);
    const sorted = [...all].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    setSkills(sorted);
    const enabled = new Set(ids.filter((id) => !id.startsWith("!")));
    const disabled = new Set(ids.filter((id) => id.startsWith("!")).map((id) => id.slice(1)));
    setEnabledIds(enabled);
    setExplicitDisabledIds(disabled);
    setStorageBytes(bytes);
  }

  function isEffectivelyEnabled(skill: SkillDefinition): boolean {
    if (explicitDisabledIds.has(skill.id)) return false;
    if (enabledIds.has(skill.id)) return true;
    return skill.enabled;
  }

  async function handleToggle(skill: SkillDefinition) {
    const current = isEffectivelyEnabled(skill);
    await setSkillEnabled(skill.id, !current);
    await loadSkills();
  }

  function openCreateForm() {
    setForm(emptyForm());
    setFormError(null);
    setShowForm(true);
  }

  function openEditForm(skill: SkillDefinition) {
    setForm(formFromSkill(skill));
    setFormError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setFormError(null);
  }

  async function handleSubmit() {
    setFormError(null);
    const v = validateAndBuild(form);
    if (!v.ok) {
      setFormError(v.error);
      return;
    }

    const isEdit = !!form.editingId;
    const newSkill: SkillDefinition = {
      id: form.editingId ?? generateUserSkillId(),
      name: v.built.name,
      description: v.built.description,
      toolSchema: { parameters: v.built.parameters },
      promptTemplate: v.built.promptTemplate,
      enabled: form.editingEnabled ?? true,
      builtIn: false,
      author: "user",
      createdAt: form.editingCreatedAt ?? Date.now(),
      allowedTools: v.built.allowedTools,
      firstRunConfirmedAt: undefined,
    };
    const newBytes = JSON.stringify(newSkill).length + `skill_${newSkill.id}`.length;
    const oldBytes = isEdit
      ? (() => {
          const existing = skills.find((s) => s.id === form.editingId);
          return existing ? JSON.stringify(existing).length + `skill_${existing.id}`.length : 0;
        })()
      : 0;
    if (storageBytes - oldBytes + newBytes > STORAGE_QUOTA_BYTES) {
      setFormError(
        `Skill storage quota would be exceeded (${formatBytes(storageBytes - oldBytes + newBytes)}/${formatBytes(STORAGE_QUOTA_BYTES)}). Delete an existing skill first.`,
      );
      return;
    }

    try {
      await saveSkill(newSkill);
      await loadSkills();
      setShowForm(false);
    } catch (e) {
      setFormError(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDelete(skill: SkillDefinition) {
    if (skill.builtIn) return;
    try {
      await deleteSkill(skill.id);
      await loadSkills();
      setConfirmDeleteId(null);
    } catch (e) {
      console.error("deleteSkill failed:", e);
    }
  }

  const quotaPct = Math.min(100, (storageBytes / STORAGE_QUOTA_BYTES) * 100);
  const builtIn = skills.filter((s) => s.builtIn);
  const custom = skills.filter((s) => !s.builtIn);

  return (
    <div className="flex flex-col gap-7">
      <CapacitySection
        skillCount={skills.length}
        storageBytes={storageBytes}
        quotaPct={quotaPct}
        showFormButton={!showForm}
        onNew={openCreateForm}
      />

      {showForm && (
        <SkillForm
          form={form}
          formError={formError}
          onChange={setForm}
          onCancel={closeForm}
          onSubmit={handleSubmit}
        />
      )}

      {builtIn.length > 0 && (
        <SkillsSection title="BUILT-IN" subtitle={`${builtIn.length} · read-only`}>
          {builtIn.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              enabled={isEffectivelyEnabled(skill)}
              supportsVision={supportsVision}
              onToggle={() => handleToggle(skill)}
              onRun={() => onRunSkill(skill.id, skill.name)}
              onEdit={() => openEditForm(skill)}
              confirmDelete={confirmDeleteId === skill.id}
              onAskDelete={() => setConfirmDeleteId(skill.id)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onDelete={() => handleDelete(skill)}
            />
          ))}
        </SkillsSection>
      )}

      {custom.length > 0 && (
        <SkillsSection title="YOURS" subtitle={`${custom.length} · editable`}>
          {custom.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              enabled={isEffectivelyEnabled(skill)}
              supportsVision={supportsVision}
              onToggle={() => handleToggle(skill)}
              onRun={() => onRunSkill(skill.id, skill.name)}
              onEdit={() => openEditForm(skill)}
              confirmDelete={confirmDeleteId === skill.id}
              onAskDelete={() => setConfirmDeleteId(skill.id)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onDelete={() => handleDelete(skill)}
            />
          ))}
        </SkillsSection>
      )}

      {skills.length === 0 && !showForm && (
        <p className="text-[12px] text-fg-3">
          No skills yet — click "+ New skill" to add one.
        </p>
      )}
    </div>
  );
}

function CapacitySection({
  skillCount,
  storageBytes,
  quotaPct,
  showFormButton,
  onNew,
}: {
  skillCount: number;
  storageBytes: number;
  quotaPct: number;
  showFormButton: boolean;
  onNew: () => void;
}) {
  const overFill = quotaPct >= 80;
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="caps text-fg-3">CAPACITY</span>
          <span className="text-[14px] font-medium text-fg-1">
            {skillCount} skill{skillCount === 1 ? "" : "s"}{" "}
            <span className="text-fg-2">
              · {formatBytes(storageBytes)} of {formatBytes(STORAGE_QUOTA_BYTES)}
            </span>
          </span>
        </div>
        {showFormButton && (
          <button
            onClick={onNew}
            className="rounded-md bg-fg-1 px-3.5 py-1.5 text-[12px] font-medium text-canvas hover:opacity-90"
          >
            + New skill
          </button>
        )}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-sm border border-line bg-surface">
        <div
          className={`h-full transition-all ${overFill ? "bg-warning" : "bg-accent"}`}
          style={{ width: `${quotaPct}%` }}
        />
      </div>
    </section>
  );
}

function SkillsSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="caps text-fg-3">{title}</span>
        <span className="font-mono text-[10px] text-fg-3">{subtitle}</span>
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line bg-line">
        {children}
      </div>
    </section>
  );
}

function SkillRow({
  skill,
  enabled,
  supportsVision,
  onToggle,
  onRun,
  onEdit,
  confirmDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  skill: SkillDefinition;
  enabled: boolean;
  /** R9 sub-path d — when false and the skill's allowedTools includes a
   *  screenshot tool, show a warning so the user knows the skill won't work
   *  with the current provider. */
  supportsVision: boolean;
  onToggle: () => void;
  onRun: () => void;
  onEdit: () => void;
  confirmDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const tag = authorTag(skill);
  const slug = normalizeSlug(skill.name) || skill.id;
  const awaitingFirstRun =
    skill.author === "agent" && skill.firstRunConfirmedAt === undefined;
  const hasScreenshotTool = (skill.allowedTools ?? []).some(
    (t) => t === "capture_visible_tab" || t === "capture_fullpage_tab",
  );
  const showVisionWarning = hasScreenshotTool && !supportsVision;

  return (
    <div
      className={`flex flex-col gap-2 bg-surface px-3.5 py-3.5 ${
        awaitingFirstRun ? "border-l-2 border-l-accent pl-[12px]" : ""
      }`}
    >
      <div className="flex items-center gap-2.5">
        <button
          onClick={onToggle}
          role="switch"
          aria-checked={enabled}
          className={`flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-full border ${
            enabled ? "border-accent bg-accent" : "border-line bg-transparent"
          }`}
          aria-label={`${enabled ? "Disable" : "Enable"} ${skill.name}`}
        />
        <code className="font-mono text-[12px] text-accent">/{slug}</code>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
          {awaitingFirstRun ? "AGENT · NEW" : tag}
        </span>
      </div>

      <p className="text-[12px] leading-[18px] text-fg-2">{skill.description}</p>

      {(skill.allowedTools ?? []).includes("open_url") && (
        <span
          className="self-start rounded border border-warning-line bg-warning-tint px-1.5 py-0.5 text-[10px] text-warning"
          title="Each open_url call requires user approval"
        >
          Per-call approval
        </span>
      )}

      {awaitingFirstRun && (
        <div className="flex items-start gap-2 rounded border border-accent-line bg-accent-tint px-2.5 py-1.5">
          <svg
            width="11"
            height="11"
            viewBox="0 0 11 11"
            fill="none"
            className="mt-0.5 flex-shrink-0"
          >
            <circle cx="5.5" cy="5.5" r="4.5" stroke="var(--c-accent)" strokeWidth="1" />
            <path
              d="M5.5 3.5V6M5.5 7.5V8"
              stroke="var(--c-accent)"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
          <span className="text-[11px] leading-[16px] text-accent">
            Will request your approval the first time the agent runs this.
          </span>
        </div>
      )}

      {showVisionWarning && (
        <div className="text-fg-3 text-xs mt-1">
          Screenshot tools in this skill require a vision-capable provider (anthropic / openai / openrouter). Current provider does not support vision.
        </div>
      )}

      <div className="flex items-center gap-2 pt-1.5">
        <span className="font-mono text-[10px] text-fg-3">
          {(skill.allowedTools ?? []).length} tool
          {(skill.allowedTools ?? []).length === 1 ? "" : "s"}
          {skill.createdAt && skill.createdAt > 0
            ? ` · ${formatBytes(JSON.stringify(skill).length)}`
            : ""}
        </span>
        <div className="flex-1" />
        <button
          onClick={onRun}
          disabled={!enabled}
          className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Run
        </button>
        {!skill.builtIn && (
          <>
            <button
              onClick={onEdit}
              className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
            >
              Edit
            </button>
            {confirmDelete ? (
              <>
                <button
                  onClick={onDelete}
                  className="rounded border border-warning-line bg-transparent px-2.5 py-1 text-[11px] text-warning hover:bg-warning-tint"
                >
                  Confirm
                </button>
                <button
                  onClick={onCancelDelete}
                  className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={onAskDelete}
                className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-3 hover:border-warning-line hover:text-warning"
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SkillForm({
  form,
  formError,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: SkillFormState;
  formError: string | null;
  onChange: React.Dispatch<React.SetStateAction<SkillFormState>>;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="caps text-fg-3">
          {form.editingId ? "EDIT SKILL" : "NEW SKILL"}
        </span>
        <button
          onClick={onCancel}
          className="text-[11px] text-fg-2 hover:text-fg-1"
        >
          Cancel
        </button>
      </div>

      {formError && (
        <div className="rounded border border-warning-line bg-warning-tint px-2.5 py-1.5 text-[12px] text-warning">
          {formError}
        </div>
      )}

      <FormField label="Name">
        <input
          value={form.name}
          onChange={(e) => onChange((p) => ({ ...p, name: e.target.value }))}
          className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder="Extract product info"
        />
      </FormField>

      <FormField label="Description">
        <input
          value={form.description}
          onChange={(e) => onChange((p) => ({ ...p, description: e.target.value }))}
          className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder="What does this skill do, and when should the agent use it?"
        />
      </FormField>

      <FormField
        label="Prompt template"
        hint={`${form.promptTemplate.length}/${PROMPT_TEMPLATE_MAX} chars`}
      >
        <textarea
          value={form.promptTemplate}
          onChange={(e) => onChange((p) => ({ ...p, promptTemplate: e.target.value }))}
          rows={6}
          className="w-full rounded border border-line bg-field px-3 py-2 font-mono text-[11px] leading-4 text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder="Use {{key}} placeholders. Example: Extract the following fields from the page: {{fields}}"
        />
      </FormField>

      <FormField label="Parameters" hint="JSON Schema">
        <textarea
          value={form.parametersText}
          onChange={(e) => onChange((p) => ({ ...p, parametersText: e.target.value }))}
          rows={6}
          className="w-full rounded border border-line bg-field px-3 py-2 font-mono text-[11px] leading-4 text-fg-1 focus:border-accent-line"
        />
      </FormField>

      <FormField label="Allowed tools" hint="comma or newline separated">
        <textarea
          value={form.allowedToolsText}
          onChange={(e) => onChange((p) => ({ ...p, allowedToolsText: e.target.value }))}
          rows={2}
          className="w-full rounded border border-line bg-field px-3 py-2 font-mono text-[11px] leading-4 text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder="scroll, wait, done, fail"
        />
        <div className="mt-1 font-mono text-[10px] text-fg-3">
          Valid: {Array.from(ALL_KNOWN_NON_SKILL_TOOL_NAMES).join(", ")}
        </div>
      </FormField>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:text-fg-1"
        >
          Cancel
        </button>
        <button
          onClick={onSubmit}
          className="rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas hover:opacity-90"
        >
          {form.editingId ? "Save changes" : "Create skill"}
        </button>
      </div>
    </section>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
          {label}
        </span>
        {hint && (
          <span className="font-mono text-[10px] text-fg-3">{hint}</span>
        )}
      </div>
      {children}
    </label>
  );
}
