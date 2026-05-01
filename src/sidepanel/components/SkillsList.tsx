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

interface SkillsListProps {
  /** Called when the user clicks Run on a skill card. Receives both the
   *  immutable id and the human name so the parent can prefer the
   *  human-readable form for the chat input prefill (Phase 2.6+ slash
   *  shorthand). */
  onRunSkill: (skillId: string, skillName: string) => void;
}

// Same caps as the meta tool handlers (kept in sync with skill-meta.ts).
const PROMPT_TEMPLATE_MAX = 8 * 1024;
const SCHEMA_STRINGS_MAX = 2 * 1024;
const STORAGE_QUOTA_BYTES = 1 * 1024 * 1024;

interface SkillFormState {
  // Set when editing; absent for create.
  editingId?: string;
  editingCreatedAt?: number;
  editingEnabled?: boolean;
  // Editable fields:
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
    return { ok: false, error: `Prompt template too long (${form.promptTemplate.length}/${PROMPT_TEMPLATE_MAX} bytes)` };
  }

  let parameters: unknown;
  try {
    parameters = JSON.parse(form.parametersText);
  } catch (e) {
    return { ok: false, error: `Parameters JSON parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { ok: false, error: "Parameters must be a JSON object (e.g. { \"type\": \"object\", ... })" };
  }
  const schemaChars = countAllStringChars(parameters);
  if (schemaChars > SCHEMA_STRINGS_MAX) {
    return { ok: false, error: `Parameters schema strings too long (${schemaChars}/${SCHEMA_STRINGS_MAX} bytes)` };
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

function authorAccentClass(skill: SkillDefinition): string {
  if (skill.builtIn) return "border-l-4 border-l-neutral-700";
  if (skill.author === "agent") return "border-l-4 border-l-purple-500";
  return "border-l-4 border-l-blue-500";
}

function authorChip(skill: SkillDefinition): { label: string; className: string } {
  if (skill.builtIn) {
    return { label: "Built-in", className: "bg-neutral-800 text-neutral-400" };
  }
  if (skill.author === "agent") {
    const ts = skill.createdAt && skill.createdAt > 0
      ? new Date(skill.createdAt).toLocaleString()
      : "unknown date";
    return { label: `Agent · ${ts}`, className: "bg-purple-900/40 text-purple-300" };
  }
  return { label: "User", className: "bg-blue-900/40 text-blue-300" };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
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

  useEffect(() => {
    loadSkills();
  }, []);

  async function loadSkills() {
    const [all, ids, bytes] = await Promise.all([
      getAllSkills(),
      getEnabledSkillIds(),
      getSkillStorageBytes(),
    ]);
    // Sort by createdAt descending; built-in (createdAt=0) sinks to the bottom.
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

    // Quota gate (parity with meta tool P1-H)
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
      // editing user-authored skill keeps undefined; if it was previously
      // agent-authored and the user is now editing it, taint stays cleared
      // (this manual edit re-enables the skill from a user trust point).
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
    if (skill.builtIn) return; // UI gate; storage layer doesn't enforce
    try {
      await deleteSkill(skill.id);
      await loadSkills();
      setConfirmDeleteId(null);
    } catch (e) {
      console.error("deleteSkill failed:", e);
    }
  }

  const quotaPct = Math.min(100, Math.round((storageBytes / STORAGE_QUOTA_BYTES) * 100));
  const quotaColorClass =
    quotaPct >= 80 ? "bg-red-600" : quotaPct >= 50 ? "bg-amber-600" : "bg-blue-600";

  return (
    <div className="flex flex-col gap-3">
      {/* Header — count + new skill button */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-400">
          {skills.length} skill{skills.length === 1 ? "" : "s"}
        </div>
        {!showForm && (
          <button
            onClick={openCreateForm}
            className="rounded bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700"
          >
            + New skill
          </button>
        )}
      </div>

      {/* Inline form for create / edit */}
      {showForm && (
        <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-3 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-medium">
              {form.editingId ? "Edit skill" : "New skill"}
            </div>
            <button
              onClick={closeForm}
              className="text-xs text-neutral-400 hover:text-neutral-200"
            >
              Cancel
            </button>
          </div>

          {formError && (
            <div className="mb-2 rounded border border-red-700 bg-red-950/40 px-2 py-1 text-xs text-red-300">
              {formError}
            </div>
          )}

          <div className="space-y-2">
            <div>
              <label className="mb-0.5 block text-xs text-neutral-400">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                className="w-full rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-blue-600"
                placeholder="Extract product info"
              />
            </div>

            <div>
              <label className="mb-0.5 block text-xs text-neutral-400">Description</label>
              <input
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                className="w-full rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-blue-600"
                placeholder="What does this skill do, and when should the agent use it?"
              />
            </div>

            <div>
              <label className="mb-0.5 block text-xs text-neutral-400">
                Prompt template ({form.promptTemplate.length}/{PROMPT_TEMPLATE_MAX} bytes)
              </label>
              <textarea
                value={form.promptTemplate}
                onChange={(e) => setForm((p) => ({ ...p, promptTemplate: e.target.value }))}
                rows={6}
                className="w-full rounded bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100 outline-none focus:ring-1 focus:ring-blue-600"
                placeholder="Use {{key}} placeholders. Example: Extract the following fields from the page: {{fields}}"
              />
            </div>

            <div>
              <label className="mb-0.5 block text-xs text-neutral-400">
                Parameters (JSON Schema)
              </label>
              <textarea
                value={form.parametersText}
                onChange={(e) => setForm((p) => ({ ...p, parametersText: e.target.value }))}
                rows={6}
                className="w-full rounded bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100 outline-none focus:ring-1 focus:ring-blue-600"
              />
            </div>

            <div>
              <label className="mb-0.5 block text-xs text-neutral-400">
                Allowed tools (comma or newline separated)
              </label>
              <textarea
                value={form.allowedToolsText}
                onChange={(e) => setForm((p) => ({ ...p, allowedToolsText: e.target.value }))}
                rows={2}
                className="w-full rounded bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100 outline-none focus:ring-1 focus:ring-blue-600"
                placeholder="scroll, wait, done, fail"
              />
              <div className="mt-0.5 text-[10px] text-neutral-500">
                Valid: {Array.from(ALL_KNOWN_NON_SKILL_TOOL_NAMES).join(", ")}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={closeForm}
                className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700"
              >
                {form.editingId ? "Save changes" : "Create skill"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Skill cards */}
      {skills.length === 0 ? (
        <p className="text-sm text-neutral-500">No skills yet — click "+ New skill" to add one.</p>
      ) : (
        skills.map((skill) => {
          const enabled = isEffectivelyEnabled(skill);
          const accent = authorAccentClass(skill);
          const chip = authorChip(skill);

          return (
            <div
              key={skill.id}
              className={`rounded-lg border border-neutral-800 bg-neutral-900 p-4 ${accent}`}
            >
              {/* Header */}
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${enabled ? "bg-green-500" : "bg-neutral-600"}`}
                  />
                  <span className="font-medium">{skill.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${chip.className}`}>
                    {chip.label}
                  </span>
                  {skill.author === "agent" && skill.firstRunConfirmedAt === undefined && (
                    <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-300">
                      Awaiting first-run confirm
                    </span>
                  )}
                </div>

                {/* Toggle */}
                <button
                  onClick={() => handleToggle(skill)}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                    enabled ? "bg-blue-600" : "bg-neutral-700"
                  }`}
                  role="switch"
                  aria-checked={enabled}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      enabled ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Description */}
              <p className="mb-3 text-xs text-neutral-400">{skill.description}</p>

              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => onRunSkill(skill.id, skill.name)}
                  disabled={!enabled}
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Run
                </button>
                {!skill.builtIn && (
                  <>
                    <button
                      onClick={() => openEditForm(skill)}
                      className="rounded bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-600"
                    >
                      Edit
                    </button>
                    {confirmDeleteId === skill.id ? (
                      <>
                        <button
                          onClick={() => handleDelete(skill)}
                          className="rounded bg-red-700 px-3 py-1.5 text-xs text-white hover:bg-red-600"
                        >
                          Confirm delete
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-600"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(skill.id)}
                        className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/40"
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })
      )}

      {/* Storage quota bar (P1-H surface) */}
      <div className="mt-2 rounded border border-neutral-800 bg-neutral-900 p-2 text-xs">
        <div className="mb-1 flex justify-between text-neutral-400">
          <span>Skill storage</span>
          <span>{formatBytes(storageBytes)} / {formatBytes(STORAGE_QUOTA_BYTES)}</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded bg-neutral-800">
          <div
            className={`h-full ${quotaColorClass} transition-all`}
            style={{ width: `${quotaPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
