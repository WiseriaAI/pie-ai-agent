import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";
import { AgentBrandIcon } from "./hitl/agent-brand-icons";

interface AgentOption {
  id: string;
  label: string;
}
interface Props {
  payload: { prompt: string; cwd: string; agents: AgentOption[] };
  /** 用户选中的后端 id（点允许）；null = 拒绝。target 由用户选，LLM 不能诱导。 */
  onDecision: (target: string | null) => void;
}

const TerminalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3" />
    <path d="M13 15h4" />
  </svg>
);

/**
 * run_local_agent 授权卡（#270 迁 HitlCardShell，warning 档）。用户在此选 headless 后端
 * （LLM 不能选——后端选择与授权是同一步，与 HandoffCard 对齐）+ prompt + cwd 原文展示
 * （不经转述）；与 handoff 卡的语义区分：结果会回到本对话。单后端时不显示选择器（无可选项）。
 */
export function RunLocalAgentCard({ payload, onDecision }: Props) {
  const t = useT();
  const agents = payload.agents ?? [];
  const [selected, setSelected] = useState(agents[0]?.id ?? "");
  return (
    <HitlCardShell
      register="local"
      icon={<TerminalIcon />}
      capsLabel={t("hitl.caps.runLocalAgent")}
      title={t("runLocalAgent.title")}
      description={t("runLocalAgent.semanticsNote")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(null)}>
            {t("runLocalAgent.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(selected)}>
            {t("runLocalAgent.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      {agents.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <span className="caps text-fg-3">{t("runLocalAgent.backendLabel")}</span>
          {agents.map((a) => {
            const isSel = a.id === selected;
            return (
              <label
                key={a.id}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 ${
                  isSel ? "border-accent-line bg-accent-tint" : "border-line"
                }`}
              >
                <input
                  type="radio"
                  name="run-local-agent-backend"
                  className="sr-only"
                  checked={isSel}
                  onChange={() => setSelected(a.id)}
                />
                <AgentBrandIcon agentId={a.id} size={16} />
                <span className={`text-[13px] ${isSel ? "text-fg-1" : "text-fg-2"}`}>{a.label}</span>
                <span
                  aria-hidden
                  className={`ml-auto h-3.5 w-3.5 shrink-0 rounded-full border ${
                    isSel ? "border-[4px] border-accent" : "border-[1.5px] border-[var(--c-fg-4)]"
                  }`}
                />
              </label>
            );
          })}
        </div>
      ) : (
        agents.length === 1 && (
          <div className="flex flex-col gap-1.5">
            <span className="caps text-fg-3">{t("runLocalAgent.backendLabel")}</span>
            <div className="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2">
              <AgentBrandIcon agentId={agents[0].id} size={16} />
              <span className="text-[13px] text-fg-1">{agents[0].label}</span>
            </div>
          </div>
        )
      )}
      <HitlDetailBlock>
        <HitlDetailGroup label={t("runLocalAgent.cwdLabel")}>
          <span className="font-mono text-[12px] leading-[18px] text-fg-1 break-all">{payload.cwd}</span>
        </HitlDetailGroup>
        <HitlDetailGroup label={t("runLocalAgent.taskLabel")}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-[18px] text-fg-1">
            {payload.prompt}
          </pre>
        </HitlDetailGroup>
      </HitlDetailBlock>
    </HitlCardShell>
  );
}
