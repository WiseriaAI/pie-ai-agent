import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";
import { AgentSelect } from "./hitl/AgentSelect";

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
      <AgentSelect
        label={t("handoff.targetLabel")}
        agents={payload.agents}
        selected={selected}
        onSelect={setSelected}
      />
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
