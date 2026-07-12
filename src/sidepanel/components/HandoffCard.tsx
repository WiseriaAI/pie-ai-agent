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
  payload: { context: string; fileCount: number; agents: AgentOption[] };
  onDecision: (target: string | null) => void;
}

const HandoffIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    <path d="m15 4 5 5-5 5" />
  </svg>
);

/**
 * 交棒授权卡（#270 迁 HitlCardShell，warning 档）：用户在此选收件人（LLM 不能选
 * ——收件人选择与授权是同一步）。context 原文渲染，让用户看到将写入 context.md
 * 的内容。与 run_local_agent 卡的语义区分：任务移交出去，结果不回来。
 */
export function HandoffCard({ payload, onDecision }: Props) {
  const t = useT();
  const [selected, setSelected] = useState(payload.agents[0]?.id ?? "");
  return (
    <HitlCardShell
      register="local"
      icon={<HandoffIcon />}
      capsLabel={t("hitl.caps.handoff")}
      title={t("handoff.title")}
      description={t("handoff.semanticsNote")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(null)}>
            {t("handoff.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(selected)}>
            {t("handoff.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="caps text-fg-3">{t("handoff.targetLabel")}</span>
        {payload.agents.map((a) => {
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
                name="handoff-target"
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
      <HitlDetailBlock>
        <HitlDetailGroup label={t("handoff.contextLabel")}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-fg-2">
            {payload.context}
          </pre>
        </HitlDetailGroup>
        {payload.fileCount > 0 && (
          <span className="text-[11px] text-fg-3">
            {t("handoff.filesLabel")}: {payload.fileCount}
          </span>
        )}
      </HitlDetailBlock>
    </HitlCardShell>
  );
}
