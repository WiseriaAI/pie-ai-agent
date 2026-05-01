import type { SkillDefinition } from "@/lib/skills";
import { normalizeSkillSlashKey } from "@/lib/skills";

interface SkillSlashPopoverProps {
  /** Filtered + sorted skill list to display. */
  skills: SkillDefinition[];
  /** Slash key the user has typed so far (without the leading `/`). */
  query: string;
  /** Index of the keyboard-highlighted row. */
  selectedIndex: number;
  /** Hover/click changes the highlight (parent updates selectedIndex). */
  onSelect: (index: number) => void;
  /** User confirmed a pick (Enter / Tab / click). */
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
      <span className="bg-blue-900/70 text-blue-100">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}

function authorChip(skill: SkillDefinition): { text: string; className: string } {
  if (skill.builtIn) return { text: "Built-in", className: "bg-neutral-800 text-neutral-400" };
  if (skill.author === "agent") return { text: "Agent", className: "bg-purple-900/50 text-purple-200" };
  return { text: "User", className: "bg-blue-900/50 text-blue-200" };
}

export default function SkillSlashPopover({
  skills,
  query,
  selectedIndex,
  onSelect,
  onPick,
}: SkillSlashPopoverProps) {
  if (skills.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 rounded border border-neutral-700 bg-neutral-900 p-2 text-xs text-neutral-500 shadow-lg">
        No skills match `/{query}`. Press Esc or keep typing.
      </div>
    );
  }

  const visible = skills.slice(0, MAX_VISIBLE);
  const overflow = skills.length - visible.length;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-h-72 overflow-auto rounded border border-neutral-700 bg-neutral-900 shadow-lg">
      <ul className="divide-y divide-neutral-800">
        {visible.map((skill, i) => {
          const slug = normalizeSkillSlashKey(skill.name) || skill.id;
          const chip = authorChip(skill);
          const selected = i === selectedIndex;
          return (
            <li
              key={skill.id}
              onMouseEnter={() => onSelect(i)}
              onMouseDown={(e) => {
                // Use mousedown so the click registers BEFORE the textarea
                // blurs (which would close the popover). preventDefault
                // also stops the focus shift so the user can keep typing.
                e.preventDefault();
                onPick(skill);
              }}
              className={`cursor-pointer px-3 py-2 text-xs ${
                selected ? "bg-neutral-800" : "hover:bg-neutral-800/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-neutral-100">
                  /{highlightSubstring(slug, query)}
                </code>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${chip.className}`}>
                  {chip.text}
                </span>
              </div>
              <div className="mt-0.5 text-neutral-300">{skill.name}</div>
              {skill.description && (
                <div className="mt-0.5 truncate text-neutral-500">{skill.description}</div>
              )}
            </li>
          );
        })}
      </ul>
      {overflow > 0 && (
        <div className="border-t border-neutral-800 px-3 py-1 text-[10px] text-neutral-500">
          {overflow} more — keep typing to narrow
        </div>
      )}
      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-neutral-800 bg-neutral-900 px-3 py-1 text-[10px] text-neutral-500">
        <span>↑↓ navigate</span>
        <span>Enter / Tab pick</span>
        <span>Esc dismiss</span>
      </div>
    </div>
  );
}
