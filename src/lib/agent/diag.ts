/**
 * 前缀缓存 / 上下文成本的诊断输出。**临时排查设施**,问题定位完就该整个删掉。
 *
 * 两个设计点都是为了「方便人从 SW console 里把几十轮数据捞出来」:
 *   1. 一行一条纯文本 —— console 里的 object 要逐个展开才能看全,也无法框选复制;
 *   2. 同时留一份在 globalThis.__pieDiag —— 在 Service Worker 的 console 里敲
 *      `copy(__pieDiag.join("\n"))` 就能把全部日志送进剪贴板,
 *      `copy(__pieDiag.slice(-40).join("\n"))` 则只要最近 40 行。
 *
 * SW 被回收时缓冲会清空,诊断用途可以接受。
 */

const MAX_LINES = 800;
const buffer: string[] = [];

/** `{a: 1, b: "x"}` → `a=1 b=x`(跳过 undefined)。 */
export function kv(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export function diag(tag: string, ...parts: string[]): void {
  const line = `[${tag}] ${parts.filter(Boolean).join(" | ")}`;
  console.log(line);
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  (globalThis as unknown as { __pieDiag?: string[] }).__pieDiag = buffer;
}
