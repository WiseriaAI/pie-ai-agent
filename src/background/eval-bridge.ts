import { runAgentLoop } from "@/lib/agent/loop";
import { createInstance, setActiveInstance, resolveInstanceToModelConfig } from "@/lib/instances";
import type { PortMessageToPanel } from "@/types/messages";

interface SessionRun {
  buffer: PortMessageToPanel[];
  controller: AbortController;
  startedAt: number;
  endedAt: number;
  terminal: "done" | "error" | "timeout" | null;
  resolveDone: ((s: "done" | "error" | "timeout") => void) | null;
  /** 最近一次 step 快照的原始 agentMessages(完整 LLM IR)。用于离线诊断。
   *  runAgentLoop 每个完成步通过 onStepSnapshot 回传(已 structuredClone)。 */
  agentMessages: unknown[];
}

/** 满足 chrome.runtime.Port 形状的最小实现:runAgentLoop 只调 postMessage。 */
function makeMockPort(sessionId: string, onMsg: (m: PortMessageToPanel) => void): chrome.runtime.Port {
  const noop = { addListener() {}, removeListener() {}, hasListener: () => false } as any;
  return {
    name: `chat-stream-${sessionId}`,
    postMessage: (m: PortMessageToPanel) => onMsg(m),
    disconnect() {},
    onMessage: noop,
    onDisconnect: noop,
  } as unknown as chrome.runtime.Port;
}

function makeBridge() {
  const runs = new Map<string, SessionRun>();
  let seededInstanceId: string | null = null;
  let seq = 0;

  function onMessage(sessionId: string, m: PortMessageToPanel) {
    const run = runs.get(sessionId);
    if (!run) return;
    run.buffer.push(m);
    if (!run.terminal && (m.type === "agent-done-task" || m.type === "chat-error" || m.type === "chat-done")) {
      run.terminal = m.type === "chat-error" ? "error" : "done";
      run.endedAt = Date.now();
      run.resolveDone?.(run.terminal);
      run.resolveDone = null;
    }
  }

  return {
    async seedConfig(cfg: { provider: string; model: string; apiKey: string }) {
      // builtin provider 路径(anthropic/openai/...);custom provider baseUrl v1 不支持。
      const id = await createInstance({ provider: cfg.provider as any, nickname: "eval", apiKey: cfg.apiKey, model: cfg.model });
      await setActiveInstance(id);
      seededInstanceId = id;
      return { instanceId: id };
    },

    async startTask(opts: { goal: string }) {
      const sessionId = `eval-${++seq}`;
      const controller = new AbortController();
      const run: SessionRun = { buffer: [], controller, startedAt: Date.now(), endedAt: 0, terminal: null, resolveDone: null, agentMessages: [] };
      runs.set(sessionId, run);

      const instanceId = seededInstanceId ?? "";
      const modelConfig = await resolveInstanceToModelConfig(instanceId);
      if (!modelConfig) throw new Error("eval bridge: seedConfig must be called before startTask");

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const pinnedTabs = tab?.id != null ? [{ tabId: tab.id, origin: new URL(tab.url ?? "about:blank").origin }] : [];

      const task = `${opts.goal}\n\nWhen the task is complete, call the \`done\` tool with your final answer as its \`result\`.`;

      void runAgentLoop({
        port: makeMockPort(sessionId, (m) => onMessage(sessionId, m)),
        task,
        modelConfig,
        signal: controller.signal,
        sessionId,
        pinnedTabs,
        initialFocusTabId: pinnedTabs[0]?.tabId,
        // 捕获每个完成步的原始会话(structuredClone'd),供 getTrace 导出诊断。
        onStepSnapshot: async (snap: { agentMessages?: unknown[] }) => {
          run.agentMessages = snap.agentMessages ?? [];
        },
      }).catch((e) => onMessage(sessionId, { type: "chat-error", error: e instanceof Error ? e.message : String(e), sessionId }));

      return { sessionId };
    },

    waitForDone(opts: { sessionId: string; timeoutMs: number }): Promise<{ status: "done" | "error" | "timeout" }> {
      const run = runs.get(opts.sessionId);
      if (!run) return Promise.resolve({ status: "error" });
      if (run.terminal) return Promise.resolve({ status: run.terminal });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          run.terminal = "timeout";
          run.endedAt = Date.now();
          run.controller.abort();
          resolve({ status: "timeout" });
        }, opts.timeoutMs);
        run.resolveDone = (s) => {
          clearTimeout(timer);
          resolve({ status: s });
        };
      });
    },

    async getTrace(opts: { sessionId: string }) {
      const run = runs.get(opts.sessionId);
      if (!run) throw new Error(`eval bridge: unknown session ${opts.sessionId}`);
      const steps = run.buffer
        .filter((m): m is Extract<PortMessageToPanel, { type: "agent-step" }> => m.type === "agent-step")
        .map((m) => ({ stepIndex: m.stepIndex, tool: m.tool, argsRedacted: m.args, status: m.status }));
      const doneStep = [...steps].reverse().find((s) => s.tool === "done");
      const doneTask = run.buffer.find((m): m is Extract<PortMessageToPanel, { type: "agent-done-task" }> => m.type === "agent-done-task");
      const errMsg = run.buffer.find((m): m is Extract<PortMessageToPanel, { type: "chat-error" }> => m.type === "chat-error");
      const lastUsage = [...run.buffer].reverse().find((m): m is Extract<PortMessageToPanel, { type: "agent-usage" }> => m.type === "agent-usage");
      const doneResult = (doneStep?.argsRedacted as { result?: string } | undefined)?.result;
      const chatText = run.buffer
        .filter((m): m is Extract<PortMessageToPanel, { type: "chat-chunk" }> => m.type === "chat-chunk")
        .map((m) => m.text)
        .join("");
      const answer = (doneResult ?? doneTask?.summary ?? chatText ?? "").trim();
      return {
        sessionId: opts.sessionId,
        agentSelfReport: { success: doneTask?.success ?? false, summary: doneTask?.summary ?? "" },
        answer,
        steps,
        usage: { inputTokens: lastUsage?.totalInputTokens ?? 0, outputTokens: lastUsage?.totalOutputTokens ?? 0 },
        startedAt: run.startedAt,
        endedAt: run.endedAt || Date.now(),
        error: errMsg?.error ?? null,
        agentMessages: run.agentMessages,
      };
    },

    async reset() {
      for (const run of runs.values()) run.controller.abort();
      runs.clear();
      await chrome.storage.local.clear();
      seededInstanceId = null;
    },
  };
}

export type EvalBridge = ReturnType<typeof makeBridge>;

/** SW 启动时(仅 eval build)挂到全局,供 Playwright serviceWorker.evaluate() 调用。 */
export function mountEvalBridge(): void {
  (globalThis as unknown as { __pieEval?: EvalBridge }).__pieEval = makeBridge();
}

/** 单测专用:直接拿一个 bridge 实例,不挂全局。 */
export function __makeBridgeForTest(): EvalBridge {
  return makeBridge();
}
