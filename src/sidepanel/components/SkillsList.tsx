import { useState, useEffect } from "react";
import type { SkillEntry } from "@/lib/skills/source";
import { filterEnabled, stripFrontmatter } from "@/lib/skills/source";
import { getEnabledSkillIds, setSkillEnabled, generateUserSkillId } from "@/lib/skills";
import {
  listSkillEntries,
  readSkillFileRpc,
  writeSkillRpc,
  deleteSkillRpc,
} from "@/lib/skills/panel-actions";
import { buildSkillMd, patchSkillMd, isSingleLineSafe } from "@/lib/skills/skill-md";
import { queryGrants, revokeGrant } from "@/lib/local-grants";
import type { GrantRecord } from "@/types/local-bridge";
import { useT } from "@/lib/i18n";

interface SkillsListProps {
  onRunSkill: (skillId: string, skillName: string) => void;
}

const INSTRUCTIONS_MAX = 8 * 1024;

interface SkillFormState {
  editingId?: string;
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

function normalizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function SkillsList({ onRunSkill }: SkillsListProps) {
  const t = useT();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  // Effective enabled-id set — derived via the SAME filterEnabled() rule the
  // slash popover and the agent loop use (builtin OR origin==="disk" default
  // on; explicit markers override), not a locally reimplemented default.
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<SkillFormState>(emptyForm());
  // 编辑打开时的原始 SKILL.md：保存走 patchSkillMd 保真更新（手写 frontmatter
  // 如 metadata.pie 原样保留）；读失败/新建为 null → 退回 buildSkillMd 全新构建。
  const [editRawMd, setEditRawMd] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // skill.name → grant（daemon 桥 ready 时查；daemon-off / IDB 模式恒空 Map）。
  const [grants, setGrants] = useState<Map<string, GrantRecord>>(new Map());

  useEffect(() => {
    void loadSkills();
  }, []);

  async function loadSkills() {
    const [res, markers] = await Promise.all([listSkillEntries(), getEnabledSkillIds()]);
    if (!res.ok) {
      console.error("[SkillsList] listSkillEntries failed:", res.error);
      setSkills([]);
      setEnabledIds(new Set());
      return;
    }
    const all = res.skills;
    const sorted = [...all].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    setSkills(sorted);
    setEnabledIds(new Set(filterEnabled(all, markers).map((e) => e.id)));
    const grantList = await queryGrants();
    setGrants(new Map(grantList.map((g) => [g.skillName, g])));
  }

  // 撤销授权：撤销后仅重查 grants（无需重拉 skills）。失败则 UI 不变，下次进入重查。
  async function handleRevoke(key: string) {
    const ok = await revokeGrant(key);
    if (ok) {
      const grantList = await queryGrants();
      setGrants(new Map(grantList.map((g) => [g.skillName, g])));
    }
  }

  function isEffectivelyEnabled(skill: SkillEntry): boolean {
    return enabledIds.has(skill.id);
  }

  async function handleToggle(skill: SkillEntry) {
    const current = isEffectivelyEnabled(skill);
    await setSkillEnabled(skill.id, !current);
    await loadSkills();
  }

  async function openEditForm(skill: SkillEntry) {
    setFormError(null);
    const res = await readSkillFileRpc(skill.id, "SKILL.md");
    if (!res.ok) {
      // Still open the form (prefilled from the already-loaded entry, empty
      // body) — a silent no-op on Edit-click would be indistinguishable from
      // a dead button. The error surfaces through the existing formError
      // banner; formError only renders inside the mounted <SkillForm>.
      console.error("readSkillFileRpc failed:", res.error);
      setEditRawMd(null); // 没拿到原文 → 保存时退回全新构建
      setForm({
        editingId: skill.id,
        name: skill.name,
        description: skill.description,
        instructions: "",
      });
      setFormError(`Load failed: ${res.error}`);
      setShowForm(true);
      return;
    }
    setEditRawMd(res.content ?? null);
    setForm({
      editingId: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: stripFrontmatter(res.content ?? ""),
    });
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

    // Builtin re-check against the freshly-loaded merged list (same guard as
    // before: the UI already hides Edit for builtin rows, but this is the
    // authoritative recheck at submit time).
    if (isEdit) {
      const existing = skills.find((s) => s.id === form.editingId);
      if (existing?.builtIn) {
        setFormError("Built-in skills cannot be edited.");
        return;
      }
    }

    const id = isEdit ? form.editingId! : generateUserSkillId();
    // 编辑且拿到过原文 → patchSkillMd 保真更新（metadata.pie 等手写 frontmatter
    // 原样保留）；新建/读失败 → buildSkillMd 全新构建。
    const md =
      isEdit && editRawMd !== null
        ? patchSkillMd(
            editRawMd,
            { name: v.built.name, description: v.built.description, author: "user" },
            v.built.instructions,
          )
        : buildSkillMd(v.built.name, v.built.description, "1.0.0", "user", v.built.instructions);

    try {
      const res = await writeSkillRpc(id, [{ path: "SKILL.md", content: md }]);
      if (!res.ok) {
        setFormError(`Save failed: ${res.error}`);
        return;
      }
      // New user packages need an explicit enabled marker — the default-on
      // rule only covers builtin/disk origins, so without this a freshly
      // created IDB skill would be excluded from the agent loop + slash
      // popover. Only on create: editing must not resurrect a skill the user
      // had explicitly disabled.
      if (!isEdit) await setSkillEnabled(id, true);
      await loadSkills();
      setShowForm(false);
    } catch (e) {
      setFormError(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDelete(skill: SkillEntry) {
    if (skill.builtIn) return;
    try {
      const res = await deleteSkillRpc(skill.id);
      if (!res.ok) {
        console.error("deleteSkillRpc failed:", res.error);
        return;
      }
      await setSkillEnabled(skill.id, false);
      await loadSkills();
      setConfirmDeleteId(null);
    } catch (e) {
      console.error("deleteSkillRpc failed:", e);
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
              grant={grants.get(skill.name) ?? null}
              onRevoke={handleRevoke}
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
  grant,
  onRevoke,
  enabled,
  onToggle,
  onRun,
  onEdit,
  confirmDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  skill: SkillEntry;
  grant: GrantRecord | null;
  onRevoke: (key: string) => void;
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
              ? t("skills.toggleAria.disable", { name: skill.name })
              : t("skills.toggleAria.enable", { name: skill.name })
          }
        />
        <code className="font-mono text-[12px] text-accent">/{slug}</code>
        <span className="ml-auto rounded-full bg-accent-tint px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
          {tag}
        </span>
      </div>

      <p className="text-[12px] leading-[18px] text-fg-2">{skill.description}</p>

      <div className="flex items-center gap-2 pt-1.5">
        {grant && (
          <span className="flex items-center gap-[5px] rounded-full border border-line bg-surface-deep px-2 py-0.5">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-success">
              <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <span className="text-[11px] text-fg-2">{t("skills.grant.granted")}</span>
          </span>
        )}
        <div className="flex-1" />
        {grant && (
          <button
            onClick={() => onRevoke(grant.key)}
            className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            {t("skills.grant.revoke")}
          </button>
        )}
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
