// Skill 纯计算脚本的 sandbox 侧执行器（spec §4.4，#68 机制）。
//
// 本文件运行在 manifest `sandbox` 声明的页面里：opaque origin，无 DOM 访问
// 价值、无 chrome.*、无 host_permissions——eval/动态 import 在这里合法（CSP
// sandbox 键放开），危害被 origin 隔离。宿主（offscreen 文档）经 postMessage
// 送 {code, input}，这里 blob import 成 ES module、调 default(input)、把
// JSON 结果发回。超时/输出上限在宿主侧强制（sandbox 内代码不可信，不能
// 自己守自己）。

export interface SandboxRunRequest {
  type: "skill-sandbox:run";
  id: string;
  code: string;
  input: unknown;
}

export interface SandboxRunReply {
  type: "skill-sandbox:result";
  id: string;
  ok: boolean;
  result?: string; // JSON string of the script's return value
  error?: string;
}

export type ImportFn = (code: string) => Promise<Record<string, unknown>>;

const blobImport: ImportFn = async (code) => {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } finally {
    URL.revokeObjectURL(url);
  }
};

export async function runScript(
  code: string,
  input: unknown,
  importFn: ImportFn,
): Promise<string> {
  let mod: Record<string, unknown>;
  try {
    mod = await importFn(code);
  } catch (e) {
    throw new Error(
      `script failed to load as an ES module: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const fn = mod.default;
  if (typeof fn !== "function") {
    throw new Error("script must `export default` a function: (input) => output");
  }
  const out = await (fn as (i: unknown) => unknown)(input);
  let json: string;
  try {
    json = JSON.stringify(out === undefined ? null : out) ?? "null";
  } catch {
    throw new Error("script output is not JSON-serializable");
  }
  return json;
}

// ── Runtime wiring（vitest/直开页面时跳过：只在被 iframe 内嵌时监听）─────────
if (typeof window !== "undefined" && window.parent !== window) {
  window.addEventListener("message", (ev) => {
    // 只认内嵌宿主（offscreen 文档）。sandbox 页拿不到 chrome.*，无法比对
    // extension origin；parent 引用比对是这里唯一可靠的发件人锚。
    if (ev.source !== window.parent) return;

    const msg = ev.data as Partial<SandboxRunRequest> | undefined;
    if (msg?.type !== "skill-sandbox:run" || typeof msg.id !== "string") return;
    const id = msg.id;
    void (async () => {
      let reply: SandboxRunReply;
      try {
        const result = await runScript(String(msg.code ?? ""), msg.input, blobImport);
        reply = { type: "skill-sandbox:result", id, ok: true, result };
      } catch (e) {
        reply = {
          type: "skill-sandbox:result",
          id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      window.parent.postMessage(reply, "*");
    })();
  });
}
