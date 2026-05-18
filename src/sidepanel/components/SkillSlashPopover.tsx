import type { SkillDefinition } from "@/lib/skills";
import { normalizeSkillSlashKey } from "@/lib/skills";
import { useT } from "@/lib/i18n";

interface SkillSlashPopoverProps {
  skills: SkillDefinition[];
  query: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onPick: (skill: SkillDefinition) => void;
}

const MAX_VISIBLE = 8;

function highlightSubstring(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const haystack = text.toLowerCase();
  const needle = q.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="rounded-[2px] bg-accent-tint px-px text-accent">
        {text.slice(idx, idx + q.length)}
      </span>
      {text.slice(idx + q.length)}
    </>
  );
}

export default function SkillSlashPopover({
  skills,
  query,
  selectedIndex,
  onSelect,
  onPick,
}: SkillSlashPopoverProps) {
  const t = useT();

  if (skills.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
          <code className="font-mono text-[11px] text-accent">/{query}</code>
          <span className="text-[11px] text-fg-3">{t("skillSlashPopover.noMatches")}</span>
        </div>
        <div className="px-3.5 py-2 text-[11px] text-fg-3">
          {t("skillSlashPopover.noMatchesHint")}
        </div>
      </div>
    );
  }

  const visible = skills.slice(0, MAX_VISIBLE);
  const overflow = skills.length - visible.length;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <code className="font-mono text-[11px] text-accent">/{query}</code>
        <span className="text-[11px] text-fg-3">{skills.length} skills</span>
      </div>
      <ul className="max-h-72 divide-y divide-line overflow-auto">
        {visible.map((skill, i) => {
          const slug = normalizeSkillSlashKey(skill.name) || skill.id;
          const tag = skill.builtIn
            ? t("skills.authorTag.builtIn")
            : skill.author === "agent"
              ? t("skills.authorTag.agent")
              : t("skills.authorTag.user");
          const selected = i === selectedIndex;
          return (
            <li
              key={skill.id}
              onMouseEnter={() => onSelect(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(skill);
              }}
              className={`flex cursor-pointer flex-col gap-1 px-3.5 py-2.5 ${
                selected ? "border-l-2 border-accent bg-accent-tint pl-[12px]" : "hover:bg-field"
              }`}
            >
              <div className="flex items-center gap-2">
                <code className="font-mono text-[12px] text-fg-1">
                  /{highlightSubstring(slug, query)}
                </code>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                  {tag}
                </span>
              </div>
              {skill.description && (
                <div className="truncate text-[12px] leading-[18px] text-fg-2">
                  {skill.description}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {overflow > 0 && (
        <div className="border-t border-line px-3.5 py-1.5 text-[10px] text-fg-3">
          {overflow} {t("skillSlashPopover.moreNarrow")}
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-line bg-canvas px-3.5 py-1.5 font-mono text-[10px] tracking-[0.08em] text-fg-3">
        <span>{t("skillSlashPopover.upDownNavigate")}</span>
        <span>{t("skillSlashPopover.enterPick")}</span>
        <span>{t("skillSlashPopover.escDismiss")}</span>
      </div>
    </div>
  );
}
