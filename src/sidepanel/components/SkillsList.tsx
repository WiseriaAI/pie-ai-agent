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
import { useT } from "@/lib/i18n";

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
}

function emptyForm(): SkillFormState {
  return {
    name: "",
    description: "",
    promptTemplate: "",
    parametersText: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
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

  return {
    ok: true,
    built: {
      name: form.name.trim(),
      description: form.description.trim(),
      promptTemplate: form.promptTemplate,
      parameters: parameters as Record<string, unknown>,
    },
  };
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
  const t = useT();
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [explicitDisabledIds, setExplicitDisabledIds] = useState<Set<string>>(new Set());
  const [storageBytes, setStorageBytes] = useState<number>(0);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<SkillFormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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

      {/* Concept hint — Skill 与底层 tool 的区别。Phase 3+ 用户经常误以为
          "为什么 click / type / open_url 这些没在列表里" — 它们是 LLM 的原子
          工具，不是 reusable workflow（skill）。 */}
      <div
        style={{
          padding: "8px 12px",
          fontSize: 12,
          color: "var(--c-fg-2, #888)",
          background: "var(--c-bg-2, transparent)",
          borderLeft: "2px solid var(--c-line, #ccc)",
          lineHeight: 1.5,
        }}
      >
        {t("skills.empty.cta")}
      </div>

      {showForm && (
        <SkillForm
          form={form}
          formError={formError}
          onChange={setForm}
          onCancel={closeForm}
          onSubmit={handleSubmit}
        />
      )}

      {custom.length > 0 && (
        <SkillsSection title={t("skills.section.yours.title")} subtitle={t("skills.section.yours.subtitleEditable", { count: custom.length })}>
          {custom.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              enabled={isEffectivelyEnabled(skill)}
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
        <p className="text-[12px] text-fg-3">{t("skills.noSkills")}</p>
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
  const t = useT();
  const overFill = quotaPct >= 80;
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="caps text-fg-3">{t("skills.capacity")}</span>
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
            {t("skills.newSkill")}
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
  onToggle: () => void;
  onRun: () => void;
  onEdit: () => void;
  confirmDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const tag = skill.builtIn
    ? t("skills.authorTag.builtIn")
    : skill.author === "agent"
      ? t("skills.authorTag.agent")
      : t("skills.authorTag.user");
  const slug = normalizeSlug(skill.name) || skill.id;

  return (
    <div
      className="flex flex-col gap-2 bg-surface px-3.5 py-3.5"
    >
      <div className="flex items-center gap-2.5">
        <button
          onClick={onToggle}
          role="switch"
          aria-checked={enabled}
          className={`flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-full border ${
            enabled ? "border-accent bg-accent" : "border-line bg-transparent"
          }`}
          aria-label={
            enabled
              ? t("skills.toggleAria.disable", { name: skill.name })
              : t("skills.toggleAria.enable", { name: skill.name })
          }
        />
        <code className="font-mono text-[12px] text-accent">/{slug}</code>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
          {tag}
        </span>
      </div>

      <p className="text-[12px] leading-[18px] text-fg-2">{skill.description}</p>

      <div className="flex items-center gap-2 pt-1.5">
        <span className="font-mono text-[10px] text-fg-3">
          {skill.createdAt && skill.createdAt > 0
            ? formatBytes(JSON.stringify(skill).length)
            : ""}
        </span>
        <div className="flex-1" />
        <button
          onClick={onRun}
          disabled={!enabled}
          className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("common.run")}
        </button>
        {!skill.builtIn && (
          <>
            <button
              onClick={onEdit}
              className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
            >
              {t("common.edit")}
            </button>
            {confirmDelete ? (
              <>
                <button
                  onClick={onDelete}
                  className="rounded border border-warning-line bg-transparent px-2.5 py-1 text-[11px] text-warning hover:bg-warning-tint"
                >
                  {t("common.confirm")}
                </button>
                <button
                  onClick={onCancelDelete}
                  className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("common.cancel")}
                </button>
              </>
            ) : (
              <button
                onClick={onAskDelete}
                className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-3 hover:border-warning-line hover:text-warning"
              >
                {t("common.delete")}
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
  const t = useT();
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="caps text-fg-3">
          {form.editingId ? t("skills.form.editSkill") : t("skills.form.newSkill")}
        </span>
        <button
          onClick={onCancel}
          className="text-[11px] text-fg-2 hover:text-fg-1"
        >
          {t("common.cancel")}
        </button>
      </div>

      {formError && (
        <div className="rounded border border-warning-line bg-warning-tint px-2.5 py-1.5 text-[12px] text-warning">
          {formError}
        </div>
      )}

      <FormField label={t("skills.form.name")}>
        <input
          value={form.name}
          onChange={(e) => onChange((p) => ({ ...p, name: e.target.value }))}
          className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder={t("skills.form.namePlaceholder")}
        />
      </FormField>

      <FormField label={t("skills.form.description")}>
        <input
          value={form.description}
          onChange={(e) => onChange((p) => ({ ...p, description: e.target.value }))}
          className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder={t("skills.form.descPlaceholder")}
        />
      </FormField>

      <FormField
        label={t("skills.form.promptTemplate")}
        hint={`${form.promptTemplate.length}/${PROMPT_TEMPLATE_MAX} chars`}
      >
        <textarea
          value={form.promptTemplate}
          onChange={(e) => onChange((p) => ({ ...p, promptTemplate: e.target.value }))}
          rows={6}
          className="w-full rounded border border-line bg-field px-3 py-2 font-mono text-[11px] leading-4 text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder={t("skills.form.promptPlaceholder")}
        />
      </FormField>

      <FormField label={t("skills.form.parameters")} hint={t("skills.form.jsonSchema")}>
        <textarea
          value={form.parametersText}
          onChange={(e) => onChange((p) => ({ ...p, parametersText: e.target.value }))}
          rows={6}
          className="w-full rounded border border-line bg-field px-3 py-2 font-mono text-[11px] leading-4 text-fg-1 focus:border-accent-line"
        />
      </FormField>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:text-fg-1"
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={onSubmit}
          className="rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas hover:opacity-90"
        >
          {form.editingId ? t("skills.form.saveChanges") : t("skills.form.createSkill")}
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
