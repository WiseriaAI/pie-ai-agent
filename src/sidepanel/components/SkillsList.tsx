import { useState, useEffect } from "react";
import type { SkillPackage } from "@/lib/skills";
import {
  getAllSkillPackages,
  getEnabledSkillIds,
  setSkillEnabled,
  putPackage,
  resolveSkillPackage,
  deletePackage,
  generateUserSkillId,
  parseSkillMarkdown,
} from "@/lib/skills";
import { buildSkillMd, isSingleLineSafe } from "@/lib/skills/skill-md";
import { useT } from "@/lib/i18n";

interface SkillsListProps {
  onRunSkill: (skillId: string, skillName: string) => void;
}

const INSTRUCTIONS_MAX = 8 * 1024;
const STORAGE_QUOTA_BYTES = 1 * 1024 * 1024;

interface SkillFormState {
  editingId?: string;
  editingCreatedAt?: number;
  name: string;
  description: string;
  instructions: string;
}

function emptyForm(): SkillFormState {
  return {
    name: "",
    description: "",
    instructions: "",
  };
}

/** Extract the SKILL.md body (instructions) from a package, tolerating
 *  malformed frontmatter by falling back to the raw file. */
function instructionsOf(pkg: SkillPackage): string {
  const md = pkg.files["SKILL.md"] ?? "";
  try {
    return parseSkillMarkdown(md).body;
  } catch {
    return md;
  }
}

function formFromSkill(skill: SkillPackage): SkillFormState {
  return {
    editingId: skill.id,
    editingCreatedAt: skill.createdAt ?? 0,
    name: skill.frontmatter.name,
    description: skill.frontmatter.description,
    instructions: instructionsOf(skill),
  };
}

/** Approximate IndexedDB bytes a package consumes (matches skill-meta.ts). */
function estimatePackageBytes(pkg: SkillPackage): number {
  return JSON.stringify(pkg).length + pkg.id.length;
}

interface BuiltSkillFields {
  name: string;
  description: string;
  instructions: string;
}

function validateAndBuild(
  form: SkillFormState,
): { ok: true; built: BuiltSkillFields } | { ok: false; error: string } {
  if (!form.name.trim()) return { ok: false, error: "Name is required" };
  if (!form.description.trim()) return { ok: false, error: "Description is required" };
  if (!form.instructions.trim()) return { ok: false, error: "Instructions are required" };
  if (form.instructions.length > INSTRUCTIONS_MAX) {
    return {
      ok: false,
      error: `Instructions too long (${form.instructions.length}/${INSTRUCTIONS_MAX} bytes)`,
    };
  }
  // Frontmatter-injection guard (shared with skill-meta.ts via skill-md.ts).
  if (!isSingleLineSafe(form.name) || !isSingleLineSafe(form.description)) {
    return { ok: false, error: "Name/description must be single-line (no newlines or '---')" };
  }

  return {
    ok: true,
    built: {
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions,
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
  const [skills, setSkills] = useState<SkillPackage[]>([]);
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
    const [all, ids] = await Promise.all([
      getAllSkillPackages(),
      getEnabledSkillIds(),
    ]);
    const sorted = [...all].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    setSkills(sorted);
    // Storage budget only accounts for user (non-built-in) packages — built-ins
    // ship with the extension and don't consume the user's IndexedDB quota.
    const bytes = sorted
      .filter((p) => !p.builtIn)
      .reduce((sum, p) => sum + estimatePackageBytes(p), 0);
    setStorageBytes(bytes);
    const enabled = new Set(ids.filter((id) => !id.startsWith("!")));
    const disabled = new Set(ids.filter((id) => id.startsWith("!")).map((id) => id.slice(1)));
    setEnabledIds(enabled);
    setExplicitDisabledIds(disabled);
  }

  function isEffectivelyEnabled(skill: SkillPackage): boolean {
    if (explicitDisabledIds.has(skill.id)) return false;
    if (enabledIds.has(skill.id)) return true;
    // Absent marker: built-ins default ON (mirrors getEnabledSkillPackages).
    // User packages require an explicit enabled marker — which the create path
    // writes via setSkillEnabled(id, true) — so an absent marker on a user
    // package means OFF. (In practice every persisted user package has a
    // marker; this fallback just keeps display parity with the loop's view.)
    return skill.builtIn;
  }

  async function handleToggle(skill: SkillPackage) {
    const current = isEffectivelyEnabled(skill);
    await setSkillEnabled(skill.id, !current);
    await loadSkills();
  }

  function openEditForm(skill: SkillPackage) {
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

    let pkg: SkillPackage;
    if (isEdit) {
      // resolveSkillPackage (merged set) so editing a builtin id resolves to the
      // builtin and is correctly blocked — store-only getPackage returned null
      // for un-overridden builtins, silently bypassing this guard.
      const existing = await resolveSkillPackage(form.editingId!);
      if (existing && existing.builtIn) {
        setFormError("Built-in skills cannot be edited.");
        return;
      }
      const md = buildSkillMd(v.built.name, v.built.description, "1.0.0", "user", v.built.instructions);
      pkg = {
        id: form.editingId!,
        frontmatter: { ...(existing?.frontmatter ?? {}), name: v.built.name, description: v.built.description, version: "1.0.0", author: "user" },
        files: { ...(existing?.files ?? {}), "SKILL.md": md },
        builtIn: false,
        createdAt: existing?.createdAt ?? form.editingCreatedAt ?? Date.now(),
      };
    } else {
      const md = buildSkillMd(v.built.name, v.built.description, "1.0.0", "user", v.built.instructions);
      pkg = {
        id: generateUserSkillId(),
        frontmatter: { name: v.built.name, description: v.built.description, version: "1.0.0", author: "user" },
        files: { "SKILL.md": md },
        builtIn: false,
        createdAt: Date.now(),
      };
    }

    const newBytes = estimatePackageBytes(pkg);
    const oldBytes = isEdit
      ? (() => {
          const existing = skills.find((s) => s.id === form.editingId);
          return existing && !existing.builtIn ? estimatePackageBytes(existing) : 0;
        })()
      : 0;
    if (storageBytes - oldBytes + newBytes > STORAGE_QUOTA_BYTES) {
      setFormError(
        `Skill storage quota would be exceeded (${formatBytes(storageBytes - oldBytes + newBytes)}/${formatBytes(STORAGE_QUOTA_BYTES)}). Delete an existing skill first.`,
      );
      return;
    }

    try {
      await putPackage(pkg);
      // New user packages need an explicit enabled marker — getEnabledSkillPackages
      // only defaults BUILT-IN packages on, so without this a freshly created
      // skill would be excluded from the agent loop + slash popover. Only on
      // create: editing must not resurrect a skill the user had explicitly disabled.
      if (!isEdit) await setSkillEnabled(pkg.id, true);
      await loadSkills();
      setShowForm(false);
    } catch (e) {
      setFormError(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDelete(skill: SkillPackage) {
    if (skill.builtIn) return;
    try {
      await deletePackage(skill.id);
      await setSkillEnabled(skill.id, false);
      await loadSkills();
      setConfirmDeleteId(null);
    } catch (e) {
      console.error("deletePackage failed:", e);
    }
  }

  const custom = skills.filter((s) => !s.builtIn);

  return (
    <div className="flex flex-col gap-7">
      {/* Concept hint — Skill 与底层 tool 的区别。Phase 3+ 用户经常误以为
          "为什么 click / type / open_url 这些没在列表里" — 它们是 LLM 的原子
          工具，不是 reusable workflow（skill）。 */}
      <div className="rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[12px] leading-[18px] text-fg-2">
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
              onRun={() => onRunSkill(skill.id, skill.frontmatter.name)}
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
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">{title}</span>
        <span className="font-mono text-[10px] text-fg-3">{subtitle}</span>
      </div>
      <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
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
  skill: SkillPackage;
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
    : skill.frontmatter.author === "agent"
      ? t("skills.authorTag.agent")
      : t("skills.authorTag.user");
  const slug = normalizeSlug(skill.frontmatter.name) || skill.id;

  return (
    <div className="flex flex-col gap-2 border-t border-line bg-surface px-3.5 py-3.5 first:border-t-0">
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
              ? t("skills.toggleAria.disable", { name: skill.frontmatter.name })
              : t("skills.toggleAria.enable", { name: skill.frontmatter.name })
          }
        />
        <code className="font-mono text-[12px] text-accent">/{slug}</code>
        <span className="ml-auto rounded-full bg-accent-tint px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
          {tag}
        </span>
      </div>

      <p className="text-[12px] leading-[18px] text-fg-2">{skill.frontmatter.description}</p>

      <div className="flex items-center gap-2 pt-1.5">
        <span className="font-mono text-[10px] text-fg-3">
          {skill.createdAt && skill.createdAt > 0
            ? formatBytes(estimatePackageBytes(skill))
            : ""}
        </span>
        <div className="flex-1" />
        <button
          onClick={onRun}
          disabled={!enabled}
          className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("common.run")}
        </button>
        {!skill.builtIn && (
          <>
            <button
              onClick={onEdit}
              className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
            >
              {t("common.edit")}
            </button>
            {confirmDelete ? (
              <>
                <button
                  onClick={onDelete}
                  className="rounded-[10px] border border-warning-line bg-transparent px-2.5 py-1 text-[11px] text-warning hover:bg-warning-tint"
                >
                  {t("common.confirm")}
                </button>
                <button
                  onClick={onCancelDelete}
                  className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("common.cancel")}
                </button>
              </>
            ) : (
              <button
                onClick={onAskDelete}
                className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-3 hover:border-warning-line hover:text-warning"
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
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">
          {form.editingId ? t("skills.form.editSkill") : t("skills.form.newSkill")}
        </span>
        <button
          onClick={onCancel}
          className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
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
          className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder={t("skills.form.namePlaceholder")}
        />
      </FormField>

      <FormField label={t("skills.form.description")}>
        <input
          value={form.description}
          onChange={(e) => onChange((p) => ({ ...p, description: e.target.value }))}
          className="w-full rounded-[10px] border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder={t("skills.form.descPlaceholder")}
        />
      </FormField>

      <FormField
        label={t("skills.form.instructions")}
        hint={`${form.instructions.length}/${INSTRUCTIONS_MAX} chars`}
      >
        <textarea
          value={form.instructions}
          onChange={(e) => onChange((p) => ({ ...p, instructions: e.target.value }))}
          rows={8}
          className="w-full rounded-[10px] border border-line bg-field px-3 py-2 font-mono text-[11px] leading-4 text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          placeholder={t("skills.form.instructionsPlaceholder")}
        />
      </FormField>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-[10px] border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:text-fg-1"
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={onSubmit}
          className="rounded-[10px] bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas hover:opacity-90"
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
        <span className="text-[12px] font-medium text-fg-2">
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
