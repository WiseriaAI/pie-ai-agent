/**
 * Recording v1 — RecordedAction[] → promptTemplate + parameters JSON Schema +
 * allowedTools。所有用户可见步骤模板字符串集中在 STEP_TEMPLATES（决议 3：i18n
 * 切换只动这一处）。
 */

import { escapeUntrustedWrappers } from "@/lib/agent/untrusted-wrappers";
import type { RecordedAction } from "./types";

export class PromptTooLargeError extends Error {
  constructor(public actualBytes: number, public maxBytes: number) {
    super(`promptTemplate is ${actualBytes} bytes, exceeds limit of ${maxBytes}`);
    this.name = "PromptTooLargeError";
  }
}

const PROMPT_TEMPLATE_MAX_BYTES = 8 * 1024;

const STEP_TEMPLATES = {
  header:
    "你是回放一段用户已演示过的网页操作流程。请按以下步骤逐步执行，每步先 snapshot 页面，再用 click / type / scroll / open_url / press_key / hover 工具操作匹配到的元素（按 Enter 或快捷键用 press_key；菜单需悬停展开时用 hover）。完成后调用 done；遇到无法继续的情况调用 fail。\n\n",
  click: (n: number, label: string) => `第 ${n} 步：点击${label}。`,
  type: (n: number, label: string, valueExpr: string) =>
    `第 ${n} 步：在${label}中输入 ${valueExpr}。`,
  select: (n: number, label: string, valueExpr: string) =>
    `第 ${n} 步：在${label}中选择 ${valueExpr}。`,
  scroll: (n: number, label: string, deltaPx: string | undefined) =>
    deltaPx
      ? `第 ${n} 步：${label}约 ${deltaPx}px。`
      : `第 ${n} 步：${label}到下一屏。`,
  submit: (n: number, label: string) => `第 ${n} 步：提交${label}所属的表单。`,
  navigate: (n: number, url: string) => `第 ${n} 步：导航到 ${url}。`,
  keypress: (n: number, key: string) => `第 ${n} 步：按 ${key} 键。`,
} as const;

const ACTION_TO_TOOL: Record<RecordedAction["type"], string | null> = {
  click: "click",
  type: "type",
  select: "select",
  scroll: "scroll",
  navigate: "open_url",
  submit: "click", // submit recorded as user pressing the submit button — replay via click
  keypress: "press_key",
};

interface SerializeResult {
  promptTemplate: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  allowedTools: string[];
}

export function serialize(actions: RecordedAction[]): SerializeResult {
  const params = new Map<string, { type: string; description: string }>();
  // `scroll` is always in baseline allowedTools — it's a read-class operation
  // (no DOM mutation, no risk), and replay LLM may need to scroll to find an
  // element even when the original demo didn't trigger scroll capture (debounce
  // could miss a small scroll, or the element was already in view at record
  // time but not at replay time on a different viewport).
  const tools = new Set<string>(["scroll", "hover", "done", "fail"]);

  if (actions.length === 0) {
    return {
      promptTemplate: "",
      parameters: { type: "object", properties: {}, required: [] },
      allowedTools: ["done", "fail", "hover", "scroll"],
    };
  }

  const lines: string[] = [STEP_TEMPLATES.header];

  actions.forEach((action, idx) => {
    const stepN = idx + 1;
    const safeLabel = escapeUntrustedWrappers(action.label);
    const tool = ACTION_TO_TOOL[action.type];
    if (tool) tools.add(tool);

    let line: string;
    switch (action.type) {
      case "click":
        line =
          action.checked === undefined
            ? STEP_TEMPLATES.click(stepN, safeLabel)
            : action.checked
              ? `第 ${stepN} 步：勾选${safeLabel}。`
              : `第 ${stepN} 步：取消勾选${safeLabel}。`;
        break;
      case "submit":
        line = STEP_TEMPLATES.submit(stepN, safeLabel);
        break;
      case "type": {
        const valueExpr = renderValueExpr(action, params);
        line = STEP_TEMPLATES.type(stepN, safeLabel, valueExpr);
        break;
      }
      case "select": {
        const valueExpr = renderValueExpr(action, params);
        line = STEP_TEMPLATES.select(stepN, safeLabel, valueExpr);
        break;
      }
      case "scroll":
        line = STEP_TEMPLATES.scroll(stepN, safeLabel, action.value);
        break;
      case "navigate":
        line = STEP_TEMPLATES.navigate(stepN, escapeUntrustedWrappers(action.url));
        break;
      case "keypress":
        line = STEP_TEMPLATES.keypress(stepN, escapeUntrustedWrappers(action.value ?? ""));
        break;
    }

    if (action.selectorHint) {
      line += ` [hint: ${escapeUntrustedWrappers(action.selectorHint)}]`;
    }
    if (action.unstable) {
      line += " [可能不稳定]";
    }
    if (action.fromPopup) {
      line += "（该项在弹出菜单/下拉中，回放前可能需先悬停或点击其触发器展开）";
    }
    lines.push(line);
  });

  const promptTemplate = lines.join("\n");

  if (promptTemplate.length > PROMPT_TEMPLATE_MAX_BYTES) {
    throw new PromptTooLargeError(promptTemplate.length, PROMPT_TEMPLATE_MAX_BYTES);
  }

  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const [name, def] of params) {
    properties[name] = def;
    required.push(name);
  }

  return {
    promptTemplate,
    parameters: { type: "object", properties, required },
    allowedTools: Array.from(tools).sort(),
  };
}

function renderValueExpr(
  action: RecordedAction,
  params: Map<string, { type: string; description: string }>,
): string {
  if (action.redacted && action.placeholderName) {
    if (!params.has(action.placeholderName)) {
      params.set(action.placeholderName, {
        type: "string",
        description: `Sensitive value redacted from recording (${action.placeholderName}).`,
      });
    }
    return `{{${action.placeholderName}}}`;
  }
  const raw = action.value ?? "";
  const safe = escapeUntrustedWrappers(raw);
  return `'${safe.length > 200 ? safe.slice(0, 200) + "..." : safe}'`;
}
