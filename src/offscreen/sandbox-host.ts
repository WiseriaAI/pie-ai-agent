// Offscreen 文档内的 sandbox iframe 宿主（spec §4.4）。
//
// 为什么住在 offscreen：SW 无 DOM 挂不了 iframe；Chrome 单扩展只允许一个
// offscreen 文档，所以 sandbox iframe 内嵌进现有 pdf-parser.html，不另建。
// 超时/输出上限在这一侧强制——sandbox 内跑的是 skill 作者代码，不可信，
// 不能让它自己守护栏。超时唯一可靠的处置是把 iframe 整个丢掉（recycle），
// 下次请求重建；楔死的脚本（死循环）没有别的杀法。

import type { SandboxRunReply, SandboxRunRequest } from "./skill-sandbox";

export const SANDBOX_TIMEOUT_MS = 5_000;
export const SANDBOX_MAX_OUTPUT_BYTES = 256 * 1024;

interface Pending {
  resolve: (json: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SandboxRpcOpts {
  /** 懒建 iframe 并等 load，返回 post 函数。 */
  ensurePort: () => Promise<(msg: SandboxRunRequest) => void>;
  /** 丢弃当前 iframe（超时卫生）。 */
  recycle: () => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function createSandboxRpc(opts: SandboxRpcOpts): {
  run: (code: string, input: unknown) => Promise<string>;
  handleReply: (msg: SandboxRunReply) => void;
} {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? SANDBOX_MAX_OUTPUT_BYTES;
  const pending = new Map<string, Pending>();

  return {
    async run(code, input) {
      const post = await opts.ensurePort();
      const id = crypto.randomUUID();
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          opts.recycle();
          reject(new Error(`skill script timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        post({ type: "skill-sandbox:run", id, code, input });
      });
    },
    handleReply(msg) {
      const p = pending.get(msg.id);
      if (!p) return; // 迟到 reply（已超时回收）——静默忽略
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (!msg.ok) {
        p.reject(new Error(msg.error || "skill script failed"));
        return;
      }
      const json = msg.result ?? "null";
      if (json.length > maxBytes) {
        p.reject(new Error(`skill script output too large (${json.length} bytes > ${maxBytes})`));
        return;
      }
      p.resolve(json);
    },
  };
}

// ── 真 iframe 接线（仅 pdf-parser.ts runtime 块调用；vitest 不触碰）──────────
export function initSandboxHost(): (code: string, input: unknown) => Promise<string> {
  let iframe: HTMLIFrameElement | null = null;
  let loaded: Promise<void> | null = null;

  const ensureIframe = (): Promise<void> => {
    if (iframe && loaded) return loaded;
    const el = document.createElement("iframe");
    el.src = chrome.runtime.getURL("src/offscreen/skill-sandbox.html");
    el.style.display = "none";
    loaded = new Promise<void>((resolve, reject) => {
      el.addEventListener("load", () => resolve(), { once: true });
      el.addEventListener("error", () => reject(new Error("sandbox iframe failed to load")), {
        once: true,
      });
    });
    document.body.appendChild(el);
    iframe = el;
    return loaded;
  };

  const rpc = createSandboxRpc({
    ensurePort: async () => {
      await ensureIframe();
      return (msg) => iframe?.contentWindow?.postMessage(msg, "*");
    },
    recycle: () => {
      iframe?.remove();
      iframe = null;
      loaded = null;
    },
  });

  window.addEventListener("message", (ev) => {
    const msg = ev.data as Partial<SandboxRunReply> | undefined;
    if (msg?.type !== "skill-sandbox:result" || typeof msg.id !== "string") return;
    rpc.handleReply(msg as SandboxRunReply);
  });

  return rpc.run;
}
