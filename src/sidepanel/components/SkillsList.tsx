import { useState, useEffect } from "react";
import type { SkillDefinition } from "@/lib/skills";
import { getAllSkills, getEnabledSkillIds, setSkillEnabled } from "@/lib/skills";

interface SkillsListProps {
  onRunSkill: (skillId: string) => void;
}

export default function SkillsList({ onRunSkill }: SkillsListProps) {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [explicitDisabledIds, setExplicitDisabledIds] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    loadSkills();
  }, []);

  async function loadSkills() {
    const [all, ids] = await Promise.all([getAllSkills(), getEnabledSkillIds()]);
    setSkills(all);
    const enabled = new Set(ids.filter((id) => !id.startsWith("!")));
    const disabled = new Set(
      ids.filter((id) => id.startsWith("!")).map((id) => id.slice(1)),
    );
    setEnabledIds(enabled);
    setExplicitDisabledIds(disabled);
  }

  function isEffectivelyEnabled(skill: SkillDefinition): boolean {
    if (explicitDisabledIds.has(skill.id)) return false;
    if (enabledIds.has(skill.id)) return true;
    return skill.enabled;
  }

  async function handleToggle(skill: SkillDefinition) {
    const current = isEffectivelyEnabled(skill);
    await setSkillEnabled(skill.id, !current);
    // Reload to reflect updated state
    await loadSkills();
  }

  if (skills.length === 0) {
    return (
      <p className="text-sm text-neutral-500">No skills available.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {skills.map((skill) => {
        const enabled = isEffectivelyEnabled(skill);

        return (
          <div
            key={skill.id}
            className="rounded-lg border border-neutral-800 bg-neutral-900 p-4"
          >
            {/* Header */}
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${enabled ? "bg-green-500" : "bg-neutral-600"}`}
                />
                <span className="font-medium">{skill.name}</span>
                {skill.builtIn && (
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-500">
                    built-in
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
            <div className="flex gap-2">
              <button
                onClick={() => onRunSkill(skill.id)}
                disabled={!enabled}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Run
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
