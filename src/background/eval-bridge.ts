import { runAgentLoop } from "@/lib/agent/loop";
import { createInstance, setActiveInstance, resolveActiveInstanceModelConfig } from "@/lib/instances";
import { setCdpInputEnabled } from "@/lib/cdp-input-enabled";
import { setSessionMeta, setSessionAgent } from "@/lib/sessions/storage";
import type { SessionMeta, SessionAgentState } from "@/lib/sessions/types";
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
      // Headless harness has no human to grant CDP-input consent — without this,
      // every click/type tool hits requestCdpInputConsent and fails ("no sidepanel
      // port"). Pre-grant it, mirroring WebArena's official eval permission
      // pre-injection. (The flag is persisted; reset() clears it between runs.)
      await setCdpInputEnabled(true);
      return { instanceId: id };
    },

    async startTask(opts: { goal: string }) {
      const sessionId = `eval-${++seq}`;
      const controller = new AbortController();
      const run: SessionRun = { buffer: [], controller, startedAt: Date.now(), endedAt: 0, terminal: null, resolveDone: null, agentMessages: [] };
      runs.set(sessionId, run);

      // Read the seeded config from the PERSISTED active instance (chrome.storage.local),
      // never from in-memory bridge state: MV3 can evict the service worker between the
      // orchestrator's seedConfig and startTask calls (e.g. during the page.goto in
      // between), which would rebuild this closure and lose any in-memory pointer. The
      // active-instance pointer survives the restart on disk.
      const modelConfig = await resolveActiveInstanceModelConfig();
      if (!modelConfig) throw new Error("eval bridge: seedConfig must be called before startTask");

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const pinnedTabs = tab?.id != null ? [{ tabId: tab.id, origin: new URL(tab.url ?? "about:blank").origin }] : [];

      // Seed a SessionMeta + SessionAgent keyed by THIS sessionId so the loop's
      // pinned-tab registry works: open_url persists new tabs via getSessionMeta→
      // setSessionMeta, and each iteration refreshes pinnedTabs from it
      // (readFocusFromStorage). Without a meta record both are silent no-ops, so
      // open_url-created tabs can never be focus_tab'd. pinMode='task' = pinnedTabs[0]
      // is the chat-start capture, [1..N] are open_url-created tabs.
      const now = Date.now();
      const meta: SessionMeta = {
        id: sessionId,
        createdAt: now,
        lastAccessedAt: now,
        status: "active",
        messages: [],
        pinMode: "task",
        ...(pinnedTabs.length > 0 ? { pinnedTabs } : {}),
      };
      await setSessionMeta(meta);
      const agentState: SessionAgentState = {
        agentMessages: [],
        pendingInstructions: [],
        stepIndex: 0,
        hasImageContent: false,
      };
      await setSessionAgent(sessionId, agentState);

      // WebArena's scorer normalizes the answer and compares it for SET EQUALITY
      // against the bare expected value (no substring/containment) — a verbose
      // sentence never matches even when it contains the right value. So instruct
      // a value-only answer, mirroring WebArena's official `stop [answer]` contract.
      const task =
        `${opts.goal}\n\n` +
        "When the task is complete, call the `done` tool with your final answer as its `result`. " +
        "The `result` must contain ONLY the precise value(s) the task asks for — a name, number, " +
        "short phrase, or comma-separated list — with no explanation, no units, no surrounding " +
        "sentence, and without restating the question. For example, reply `42`, not `The total is 42 items.`";

      void runAgentLoop({
        port: makeMockPort(sessionId, (m) => onMessage(sessionId, m)),
        task,
        modelConfig,
        signal: controller.signal,
        sessionId,
        pinnedTabs,
        initialFocusTabId: pinnedTabs[0]?.tabId,
        // 捕获每个完成步的原始会话(structuredClone'd),供 getTrace 导出诊断。
        // 只在非空时更新:任务 done 时 loop 会再发一个 tombstone 快照,其
        // agentMessages 为 [](buildSessionAgentTombstone),不能让它清掉已捕获的历史。
        onStepSnapshot: async (snap: { agentMessages?: unknown[] }) => {
          if (snap.agentMessages && snap.agentMessages.length > 0) {
            run.agentMessages = snap.agentMessages;
          }
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
