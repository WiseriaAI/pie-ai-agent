import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Switch } from "../../ui/Switch";
import { AgentBrandIcon } from "../../hitl/agent-brand-icons";
import { queryBridgeStatus, type BridgeStatus } from "../bridge-status";

// Pie Link 安装包稳定 URL（release latest）——升级卡下载按钮直链（升级用户已知 Pie Link 是什么，直链摩擦最小）。
const PKG_URL = "https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link.pkg";
// 官网 Pie Link 介绍页（介绍 + 下载 + 卸载说明）——首次安装卡跳这里，给首装用户上下文。
const LINK_URL = "https://www.pie.chat/link";

// 首连排障引导（#328）：连续失败超过此阈值就追加「首次安装需要重启」排障块。人工拍板
// （见 PR #329 review）把阈值从 5 降到 1——首次连接失败即提示，不再等退避梯子跑 ~1 分钟。
// 该块只在「开关开着 && 没连上」时出现，首次失败即提示不算打扰。SW 侧的失败计数 /
// lastDisconnectError 留存 / console.warn 证据链保留不动（钉根因仍需要）。
const TROUBLESHOOT_THRESHOLD = 1;

type PanelAgent = { id: string; label: string; installed: boolean; enabled: boolean; kind?: "app" | "terminal" };

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

// 本地打通开关 + 实时状态。开=请求 nativeMessaging（用户手势）→ SW onAdded 连桥；
// 关=移除权限 → SW onRemoved 断桥。挂载期每 1.5s 轮询一次状态（连接是异步的）。
/** agent 名称/kind 拆分：有 kind 时剥掉 label 里的 "(App)"/"(Terminal)" 尾缀显示两行；
 *  旧 daemon 无 kind → 整串 label 单行回退。 */
function splitAgentLabel(a: PanelAgent): { name: string; sub: string | null } {
  if (!a.kind) return { name: a.label, sub: null };
  const name = a.label.replace(/\s*\((App|Terminal)\)\s*$/i, "");
  const sub = a.kind === "app" ? "App" : "Terminal";
  return { name, sub };
}

export function LocalBridgeSection() {
  const t = useT();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [agents, setAgents] = useState<PanelAgent[]>([]);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [view, setView] = useState<"main" | "agents">("main");

  useEffect(() => {
    queryBridgeStatus(setStatus);
    const id = setInterval(() => queryBridgeStatus(setStatus), 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status?.ready) queryLocalAgents(setAgents);
    else {
      setAgents([]);
      setView("main"); // 桥断开 → 管理子视图失去意义，强制回主视图
    }
  }, [status?.ready]);

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

  // 安装卡「重新检测」：让 SW 立即重连（重置退避 + 重新握手），随后立即再查一次状态。
  const onRecheck = () => {
    try {
      chrome.runtime.sendMessage({ type: "local-bridge:reconnect" }, () => {
        if (chrome.runtime.lastError) return;
        queryBridgeStatus(setStatus);
      });
    } catch {
      /* noop */
    }
  };

  // 排障引导「重启扩展」：直接 chrome.runtime.reload()，替用户做掉 chrome://extensions
  // 手动刷新那步。会关闭侧栏（文案已提示需重新打开）。
  const onRestartExtension = () => {
    try {
      chrome.runtime.reload();
    } catch {
      /* noop */
    }
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

  // protocolMismatch 是 not-ready 状态（见 local-bridge.ts 握手），不能被 ready 门住；
  // 只有软升级（needsUpgrade）要求已连上（ready）。
  const showUpgrade = !!status?.protocolMismatch || (!!status?.ready && !!status.needsUpgrade);

  // 安装引导漏斗（Slice 4）：开关开、未连、且不是升级态时，按 SW 分类的 installState
  // 呈现——未安装 → 安装卡；已装未连 → doctor 引导。unknown / undefined（旧 SW）落回
  // 现有「未连接」文案（向后兼容）。
  const installState = status?.installState;
  const notReadyEnabled = enabled && status != null && !status.ready && !showUpgrade;
  const showInstallCard = notReadyEnabled && installState === "not_installed";
  const showDoctorHint = notReadyEnabled && installState === "installed_not_running";
  // 首连排障块（#328）：开关开、未连、非升级态、且已有连接失败时，在安装卡/doctor 卡下
  // 追加。直给「首次安装需要重启扩展」引导——覆盖「装了、跑了、Chrome 就是连不上」这条
  // 既有卡片没覆盖的失败叙事。旧 SW 不回 failedAttempts → ?? 0 → 不出现（向后兼容）。
  const showTroubleshoot = notReadyEnabled && (status?.failedAttempts ?? 0) >= TROUBLESHOOT_THRESHOLD;

  const statusText =
    status == null
      ? ""
      : !status.hasPermission
        ? t("settings.localBridge.statusOff")
        : status.ready
          ? t("settings.localBridge.statusConnected") +
            (status.daemonVersion ? ` · Pie Link v${status.daemonVersion}` : "")
          : // protocol 硬不兼容时握手不置 ready（ready===false 与 protocolMismatch===true
            // 互斥），单独给强状态文案，别让它落到普通「未连接」。
            status.protocolMismatch
            ? t("settings.localBridge.statusIncompatible")
            : // 未装/已装未连由下方专用卡片承载文案，状态行留空避免重复。
              showInstallCard || showDoctorHint
              ? ""
              : t("settings.localBridge.statusEnabledNotConnected");

  const enabledAgents = agents.filter((a) => a.enabled);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">
          {t("settings.localBridge.sectionTitle")}
        </span>
      </div>
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3.5">
        {view === "main" ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <div className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.title")}</div>
                <div className="text-[12px] leading-relaxed text-fg-3">{t("settings.localBridge.description")}</div>
                {statusText && (
                  <div className="flex items-center gap-1.5">
                    {status?.ready && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}
                    <span className={`text-[12px] ${status?.ready ? "text-fg-1" : "text-fg-3"}`}>{statusText}</span>
                  </div>
                )}
              </div>
              <Switch checked={enabled} onChange={onToggle} />
            </div>
            {showUpgrade && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[12px] leading-relaxed text-fg-2">
                  {status?.protocolMismatch
                    ? t("settings.localBridge.upgradeRequired")
                    : t("settings.localBridge.upgradeAvailable")}
                </div>
                <a
                  href={PKG_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.downloadUpdate")}
                </a>
              </div>
            )}
            {showInstallCard && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.installTitle")}</div>
                <div className="text-[12px] leading-relaxed text-fg-2">{t("settings.localBridge.installBody")}</div>
                <div className="flex items-center gap-2">
                  <a
                    href={LINK_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                  >
                    {t("settings.localBridge.installDownload")}
                  </a>
                  <button
                    type="button"
                    onClick={onRecheck}
                    className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                  >
                    {t("settings.localBridge.recheck")}
                  </button>
                </div>
              </div>
            )}
            {showDoctorHint && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[12px] leading-relaxed text-fg-2">{t("settings.localBridge.doctorHint")}</div>
                <button
                  type="button"
                  onClick={onRecheck}
                  className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.recheck")}
                </button>
              </div>
            )}
            {showTroubleshoot && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="text-[13px] font-medium text-fg-1">
                  {t("settings.localBridge.troubleshootTitle")}
                </div>
                <div className="text-[12px] leading-relaxed text-fg-2">
                  {t("settings.localBridge.troubleshootBody")}
                </div>
                <button
                  type="button"
                  onClick={onRestartExtension}
                  className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.troubleshootRestartExtension")}
                </button>
                <div className="text-[12px] leading-relaxed text-fg-3">
                  {t("settings.localBridge.troubleshootFallback")}
                </div>
              </div>
            )}
            {status?.ready && agents.length > 0 && (
              <div className="flex flex-col gap-2.5 border-t border-line pt-3">
                {enabledAgents.length > 0 && (
                  <>
                    <span className="caps text-fg-3">{t("settings.localBridge.agentsEnabledTitle")}</span>
                    {enabledAgents.map((a) => {
                      const { name, sub } = splitAgentLabel(a);
                      return (
                        <div key={a.id} className="flex items-center gap-2.5">
                          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-chip bg-field text-fg-2">
                            <AgentBrandIcon agentId={a.id} size={14} />
                          </span>
                          <span className="text-[13px] text-fg-1">{name}</span>
                          {sub && <span className="text-[11px] text-fg-3">{sub}</span>}
                        </div>
                      );
                    })}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setView("agents")}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 py-[7px] text-[12px] font-medium text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.manageAgents")}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Back"
                onClick={() => setView("main")}
                className="flex h-5 w-5 items-center justify-center rounded text-fg-2 hover:text-fg-1"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <span className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.manageAgents")}</span>
            </div>
            {agents.map((a) => {
              const { name, sub } = splitAgentLabel(a);
              const subLine = [sub, a.installed ? null : t("settings.localBridge.agentNotInstalled")]
                .filter(Boolean)
                .join(" · ");
              return (
                <div key={a.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-chip bg-field ${a.installed ? "text-fg-2" : "text-fg-3"}`}
                    >
                      <AgentBrandIcon agentId={a.id} size={14} />
                    </span>
                    <div className="flex grow flex-col">
                      <span className={`text-[13px] ${a.installed ? "text-fg-1" : "text-fg-2"}`}>{name}</span>
                      {subLine && <span className="text-[11px] text-fg-3">{subLine}</span>}
                    </div>
                    <Switch checked={a.enabled} onChange={(next) => onAgentToggle(a.id, next)} />
                  </div>
                  {failedId === a.id && (
                    <div className="text-[11px] text-fg-3">{t("settings.localBridge.agentEnableFailed")}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default function BridgePage() {
  return <LocalBridgeSection />;
}
