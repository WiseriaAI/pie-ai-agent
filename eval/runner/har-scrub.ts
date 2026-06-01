import type { Har, HarHeader } from "./types";

/** 默认剥掉的敏感 header(大小写不敏感)。WebArena 的 session cookie 默认也剥;
 *  若后续契约确认评估器需要保留 cookie 做 trace replay,把 "cookie"/"set-cookie"
 *  从这里移除,并在 EVALUATOR_CONTRACT.md 记录。 */
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"]);

function stripHeaders(headers: HarHeader[]): HarHeader[] {
  return headers.filter((h) => !SENSITIVE_HEADERS.has(h.name.toLowerCase()));
}

/** 只保留 host 在 allowedHosts 的 entry(provider 调用因此被整条剔除,BYOK key 不落盘),
 *  并剥掉保留 entry 上的敏感 header。返回新对象;log/entries 数组与每个 entry 的
 *  request/response header 数组都是新建的,但 request/response 上的其它嵌套字段
 *  (如 postData)与输入共享引用(scrubber 只读不写这些字段)。 */
export function scrubHar(har: Har, allowedHosts: string[]): Har {
  const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const entries = har.log.entries
    .filter((e) => {
      try {
        return hosts.has(new URL(e.request.url).host.toLowerCase());
      } catch {
        return false;
      }
    })
    .map((e) => ({
      ...e,
      request: { ...e.request, headers: stripHeaders(e.request.headers) },
      response: { ...e.response, headers: stripHeaders(e.response.headers) },
    }));
  return { ...har, log: { ...har.log, entries } };
}
