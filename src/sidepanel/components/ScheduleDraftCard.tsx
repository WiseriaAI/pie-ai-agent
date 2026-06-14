import { useState } from "react";
import type { DecryptedInstance } from "@/lib/instances";
import { useT } from "@/lib/i18n";
import ModelPicker from "./ModelPicker";
import type { ScheduleDraftPayload } from "@/lib/agent/tools/schedule-meta";

interface Props {
  payload: ScheduleDraftPayload;
  instances: DecryptedInstance[];
  onSubmit: (instanceId: string, model: string) => void;
  onCancel: () => void;
}

/**
 * #184 — 挂起式模型选择卡。chat 建 schedule 未指定/非法模型时弹出，复用
 * Composer 的 ModelPicker；提交回 (instanceId, model)，工具 await 至此 resolve。
 * 与 CdpOnboardingCard / LocalFileRequestCard 同构，Chat 内联渲染。
 */
export function ScheduleDraftCard({ payload, instances, onSubmit, onCancel }: Props) {
  const t = useT();
  const [sel, setSel] = useState<{ instanceId: string; model: string } | null>(null);

  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-fg-2">
      <div className="font-medium text-fg-1">{t("schedules.draftCardTitle")}</div>
      <div className="mt-1 text-fg-2">{payload.title}</div>
      <div className="mt-0.5 text-fg-3">{payload.specSummary}</div>

      <div className="mt-2">
        <ModelPicker
          instances={instances}
          currentInstanceId={sel?.instanceId ?? null}
          currentModel={sel?.model ?? null}
          locked={false}
          onSelect={(instanceId, model) => setSel({ instanceId, model })}
        />
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-white disabled:opacity-50"
          disabled={!sel}
          onClick={() => sel && onSubmit(sel.instanceId, sel.model)}
        >
          {t("schedules.draftCardCreate")}
        </button>
        <button type="button" className="rounded-md border border-line px-3 py-1.5" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
