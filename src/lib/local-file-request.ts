// SW↔panel round-trip for the `request_local_file` human-in-the-loop tool。
// 退化为 panel-request 原语的薄适配器；类型/超时常量保持对外可见。
import { requestFromPanel } from "./panel-request";

export interface LocalFileResult {
  name: string;
  mime: string;
  text: string;
  truncated: boolean;
}

export const REQUEST_TIMEOUT_MS = 120_000;

export async function requestLocalFileFromPanel(sessionId: string): Promise<LocalFileResult> {
  return requestFromPanel(sessionId, "local-file", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
}
