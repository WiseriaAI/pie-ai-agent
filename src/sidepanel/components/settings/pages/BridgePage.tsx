import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import type { GrantRecord, AuditEntry } from "@/types/local-bridge";
import { Switch } from "../../ui/Switch";
import { queryBridgeStatus, type BridgeStatus } from "../bridge-status";

type PanelAgent = { id: string; label: string; installed: boolean; enabled: boolean };

// Settings「本地 Agent」列表 — 一次性查询，无轮询（挂载/桥就绪/开关交互后各触发一次）。
function queryLocalAgents(cb: (agents: PanelAgent[]) => void): void {
  try {
    chrome.runtime.sendMessage({ type: "local-agents:list" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && Array.isArray(res.agents)) cb(res.agents as PanelAgent[]);
    });
  } catch {
    /* noop */
  }
}

// Settings「本地打通」— 已授权 skill grants 一次性查询（无轮询）。
function queryGrants(cb: (grants: GrantRecord[]) => void): void {
  try {
    chrome.runtime.sendMessage({ type: "local-grants:list" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && Array.isArray(res.grants)) cb(res.grants as GrantRecord[]);
    });
  } catch {
    /* noop */
  }
}

// Settings「本地打通」— 最近脚本执行审计一次性查询（无轮询）。
function queryAudit(cb: (entries: AuditEntry[]) => void): void {
  try {
    chrome.runtime.sendMessage({ type: "local-audit:list" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && Array.isArray(res.entries)) cb(res.entries as AuditEntry[]);
    });
  } catch {
    /* noop */
  }
}

// 本地打通开关 + 实时状态。开=请求 nativeMessaging（用户手势）→ SW onAdded 连桥；
// 关=移除权限 → SW onRemoved 断桥。挂载期每 1.5s 轮询一次状态（连接是异步的）。
export function LocalBridgeSection() {
  const t = useT();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [agents, setAgents] = useState<PanelAgent[]>([]);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [grants, setGrants] = useState<GrantRecord[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);

  useEffect(() => {
    queryBridgeStatus(setStatus);
    const id = setInterval(() => queryBridgeStatus(setStatus), 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status?.ready) queryLocalAgents(setAgents);
    else setAgents([]);
  }, [status?.ready]);

  useEffect(() => {
    if (status?.ready) {
      queryGrants(setGrants);
      queryAudit(setAudit);
    } else {
      setGrants([]);
      setAudit([]);
    }
  }, [status?.ready]);

  const onRevoke = (key: string) => {
    try {
      chrome.runtime.sendMessage({ type: "local-grants:revoke", key }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.ok) queryGrants(setGrants);
      });
    } catch {
      /* noop */
    }
  };

  const enabled = status?.hasPermission ?? false;
  const onToggle = async (next: boolean) => {
    try {
      if (next) await chrome.permissions.request({ permissions: ["nativeMessaging"] });
      else await chrome.permissions.remove({ permissions: ["nativeMessaging"] });
    } catch {
      /* 用户取消了权限弹窗 */
    }
    queryBridgeStatus(setStatus);
  };

  const onAgentToggle = (id: string, next: boolean) => {
    setFailedId(null);
    try {
      chrome.runtime.sendMessage({ type: "local-agents:toggle", id, next }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.ok) queryLocalAgents(setAgents);
        else setFailedId(id);
      });
    } catch {
      /* noop */
    }
  };

  const statusText =
    status == null
      ? ""
      : !status.hasPermission
        ? t("settings.localBridge.statusOff")
        : status.ready
          ? t("settings.localBridge.statusConnected")
          : t("settings.localBridge.statusEnabledNotConnected");

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">
          {t("settings.localBridge.sectionTitle")}
        </span>
      </div>
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.title")}</div>
            <div className="text-[12px] leading-relaxed text-fg-3">{t("settings.localBridge.description")}</div>
            {statusText && (
              <div className={`text-[12px] ${status?.ready ? "text-fg-1" : "text-fg-3"}`}>{statusText}</div>
            )}
          </div>
          <Switch checked={enabled} onChange={onToggle} />
        </div>
        {status?.ready && agents.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="text-[12px] font-medium text-fg-2">{t("settings.localBridge.agentsTitle")}</div>
            {agents.map((a) => (
              <div key={a.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] text-fg-1">{a.label}</span>
                    {!a.installed && (
                      <span className="text-[11px] text-fg-3">{t("settings.localBridge.agentNotInstalled")}</span>
                    )}
                  </div>
                  <Switch checked={a.enabled} onChange={(next) => onAgentToggle(a.id, next)} />
                </div>
                {failedId === a.id && (
                  <div className="text-[11px] text-fg-3">{t("settings.localBridge.agentEnableFailed")}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {status?.ready && grants.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="text-[12px] font-medium text-fg-2">{t("settings.localBridge.grantsTitle")}</div>
            {grants.map((g) => (
              <div key={g.key} className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[13px] text-fg-1">{g.skillName}</span>
                  <span className="text-[11px] text-fg-3">
                    {g.envelope.runnableScripts.join(", ")}
                    {g.envelope.allowedDomains.length > 0 && ` · ${g.envelope.allowedDomains.join(", ")}`}
                    {g.envelope.extraWrites.length > 0 && ` · ${g.envelope.extraWrites.join(", ")}`}
                  </span>
                  <span className="text-[11px] text-fg-3">
                    {new Date(g.grantedAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRevoke(g.key)}
                  className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.revoke")}
                </button>
              </div>
            ))}
          </div>
        )}
        {status?.ready && audit.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => setAuditOpen((v) => !v)}
              className="self-start text-[12px] font-medium text-fg-2 hover:text-fg-1"
            >
              {t("settings.localBridge.auditTitle")} {auditOpen ? "▾" : "▸"}
            </button>
            {auditOpen &&
              audit.map((e, i) => (
                <div key={`${e.ts}-${i}`} className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="truncate text-fg-1">
                    {e.skillName} · {e.entry}
                  </span>
                  <span className="shrink-0 text-fg-3">
                    {e.exitCode === 0 && !e.timedOut
                      ? t("settings.localBridge.auditOk")
                      : t("settings.localBridge.auditFailed")}
                    {" · "}
                    {new Date(e.ts).toLocaleString()}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default function BridgePage() {
  return <LocalBridgeSection />;
}
