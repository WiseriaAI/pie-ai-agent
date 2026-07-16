import { AnimatePresence } from "../ui/motion";
import type { ActivePanelRequest, PanelResponseBody } from "../../hooks/usePanelRequest";
import type { DecryptedInstance } from "@/lib/instances";
import { ScheduleDraftCard } from "../ScheduleDraftCard";
import { SkillGrantCard } from "../SkillGrantCard";
import { RunLocalAgentCard } from "../RunLocalAgentCard";
import { HandoffCard } from "../HandoffCard";
import { LocalFileRequestCard } from "../LocalFileRequestCard";
import { CdpOnboardingCard } from "../CdpOnboardingCard";

export interface HitlInlineCardsProps {
  request: ActivePanelRequest | null;
  respond: (requestId: string, body: PanelResponseBody) => void;
  instances: DecryptedInstance[];
  /** local-file 卡的"选择文件"手势 → Chat.tsx 隐藏 input 的 click() */
  onChooseLocalFile: () => void;
}

/**
 * #270 — 全部 panel-request kind 的内联渲染点（消息流尾部，#184 范式）。
 * AnimatePresence 在此包裹，卡组件（m.div 根）unmount 时 exit 动画生效。
 * key=requestId：换请求时强制重挂载，内部 state（倒计时/选择）不串台。
 */
export function HitlInlineCards({ request, respond, instances, onChooseLocalFile }: HitlInlineCardsProps) {
  return (
    <AnimatePresence>
      {request?.kind === "schedule-model" && (
        <ScheduleDraftCard
          key={request.requestId}
          payload={request.payload as import("@/lib/agent/tools/schedule-meta").ScheduleDraftPayload}
          instances={instances}
          onSubmit={(instanceId, model) =>
            respond(request.requestId, { ok: true, data: { instanceId, model } })
          }
          onCancel={() => respond(request.requestId, { ok: false, reason: "cancelled by user" })}
        />
      )}
      {request?.kind === "skill-grant" && (
        <SkillGrantCard
          key={request.requestId}
          payload={request.payload as import("@/lib/agent/tools/skill-script").SkillGrantRequest}
          onDecision={(approved) => respond(request.requestId, { ok: true, data: approved })}
        />
      )}
      {request?.kind === "run-local-agent" && (
        <RunLocalAgentCard
          key={request.requestId}
          payload={
            request.payload as {
              prompt: string;
              cwd: string;
              agents: { id: string; label: string }[];
            }
          }
          onDecision={(target) => respond(request.requestId, { ok: true, data: target })}
        />
      )}
      {request?.kind === "handoff-to-agent" && (
        <HandoffCard
          key={request.requestId}
          payload={
            request.payload as {
              context: string;
              fileCount: number;
              agents: { id: string; label: string }[];
            }
          }
          onDecision={(target) => respond(request.requestId, { ok: true, data: target })}
        />
      )}
      {request?.kind === "local-file" && (
        <LocalFileRequestCard
          key={request.requestId}
          onChoose={onChooseLocalFile}
          onCancel={() => respond(request.requestId, { ok: false, reason: "cancelled by user" })}
        />
      )}
      {request?.kind === "cdp-consent" && (
        <CdpOnboardingCard
          key={request.requestId}
          onAnswer={(enabled) => respond(request.requestId, { ok: true, data: enabled })}
        />
      )}
    </AnimatePresence>
  );
}
