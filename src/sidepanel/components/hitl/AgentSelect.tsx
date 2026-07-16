import { useState } from "react";
import { AgentBrandIcon } from "./agent-brand-icons";
import { DropdownPanel } from "../ui/DropdownPanel";

interface AgentOption {
  id: string;
  label: string;
}
interface Props {
  /** caps 分组标题（如「后端」/「交给」）。 */
  label: string;
  agents: AgentOption[];
  selected: string;
  onSelect: (id: string) => void;
}

/**
 * HITL 授权卡上的本地 agent 选择器（RunLocalAgentCard / HandoffCard 共用）。
 * 多于一个：下拉浮层（absolute 覆盖卡片内容，不撑高卡片；非 portal——HitlCardShell
 * 无 overflow 裁剪，够用）。单个：静态行（无可选项，用户仍看得到跑在哪）。
 */
export function AgentSelect({ label, agents, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const selectedAgent = agents.find((a) => a.id === selected);
  if (agents.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="caps text-fg-3">{label}</span>
      {agents.length > 1 ? (
        <div className="relative">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-field px-2.5 py-2 text-left"
          >
            <AgentBrandIcon agentId={selected} size={16} />
            <span className="text-[13px] text-fg-1">{selectedAgent?.label}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="ml-auto shrink-0 text-fg-3" style={{ transform: open ? "rotate(180deg)" : "none" }}>
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <DropdownPanel
            open={open}
            role="listbox"
            className="absolute inset-x-0 top-full z-10 mt-1 flex max-h-[220px] flex-col overflow-y-auto rounded-lg border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
          >
            {agents.map((a) => {
              const isSel = a.id === selected;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  onClick={() => {
                    onSelect(a.id);
                    setOpen(false);
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-[13px] hover:bg-field ${
                    isSel ? "bg-accent-tint text-fg-1" : "text-fg-2"
                  }`}
                >
                  <AgentBrandIcon agentId={a.id} size={16} />
                  <span>{a.label}</span>
                </button>
              );
            })}
          </DropdownPanel>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2">
          <AgentBrandIcon agentId={agents[0].id} size={16} />
          <span className="text-[13px] text-fg-1">{agents[0].label}</span>
        </div>
      )}
    </div>
  );
}
