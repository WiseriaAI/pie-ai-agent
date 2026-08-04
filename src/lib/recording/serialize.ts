/**
 * Recording v1 — RecordedAction[] → promptTemplate + parameters JSON Schema +
 * allowedTools。
 *
 * The promptTemplate is a **fixed English scaffold** (issue #342), NOT localized:
 * it is a one-shot generated artifact baked into the skill + an instruction to the
 * replay LLM, which reads any language fine. Fixing it to English makes it universal
 * across replay providers and removes the "which UI locale was active at save time"
 * branch. Only page-verbatim `name` / `value` are carried through as-is.
 */

import { escapeUntrustedWrappers } from "@/lib/agent/untrusted-wrappers";
import type { RecordedAction, RecordedTarget, TargetKindKey, RegionKey, TabRegistry } from "./types";

export class PromptTooLargeError extends Error {
  constructor(public actualBytes: number, public maxBytes: number) {
    super(`promptTemplate is ${actualBytes} bytes, exceeds limit of ${maxBytes}`);
    this.name = "PromptTooLargeError";
  }
}

const PROMPT_TEMPLATE_MAX_BYTES = 8 * 1024;

const STEP_TEMPLATES = {
  header:
    "You are replaying a web workflow the user already demonstrated. Follow each step in order: first snapshot the page, then use the click / type / scroll / open_url / press_key / hover tools to operate the matched element (use press_key for Enter or shortcuts; use hover when a menu needs to be expanded). Call done when finished; call fail if you cannot continue.\n\n",
  click: (n: number, target: string) => `Step ${n}: click ${target}.`,
  check: (n: number, target: string) => `Step ${n}: check ${target}.`,
  uncheck: (n: number, target: string) => `Step ${n}: uncheck ${target}.`,
  type: (n: number, target: string, valueExpr: string) =>
    `Step ${n}: type ${valueExpr} into ${target}.`,
  select: (n: number, target: string, valueExpr: string) =>
    `Step ${n}: select ${valueExpr} in ${target}.`,
  scroll: (n: number, direction: "down" | "up", deltaPx: string | undefined) =>
    deltaPx
      ? `Step ${n}: scroll ${direction} about ${deltaPx}px.`
      : `Step ${n}: scroll ${direction} to the next screen.`,
  submit: (n: number, target: string) => `Step ${n}: submit the form containing ${target}.`,
  navigate: (n: number, url: string) => `Step ${n}: navigate to ${url}.`,
  keypress: (n: number, key: string) => `Step ${n}: press the ${key} key.`,
  spawnTab: (origin: string) =>
    `— The previous click opens a new tab; switch to it and continue (target site: ${origin}).`,
  switchTab: (origin: string) => `— Switch back to the ${origin} tab and continue.`,
} as const;

// Fixed English kind/region words for the replay scaffold. Language-neutral by
// design (issue #342) — the panel renderer localizes separately via i18n dicts.
const KIND_EN: Record<TargetKindKey, string> = {
  button: "button", link: "link", tab: "tab", checkbox: "checkbox",
  radio: "radio", switch: "switch", menuitem: "menu item", option: "option",
  input: "input", textarea: "text area", dropdown: "dropdown",
  summary: "disclosure", element: "element", editor: "editor",
};
const REGION_EN: Record<RegionKey, string> = {
  main: "main", nav: "nav", header: "header", footer: "footer",
  aside: "sidebar", other: "other",
};

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Compose the English target phrase (e.g. `the button "Submit"`) from structure codes. */
function describeTargetEn(target: RecordedTarget | undefined): string {
  if (!target) return "the element";
  const kind = KIND_EN[target.kindKey] ?? "element";
  if (target.editorEngine) {
    return `the ${escapeUntrustedWrappers(target.editorEngine)} editor`;
  }
  if (target.name) {
    const name = escapeUntrustedWrappers(target.name);
    // Bracket forms like (placeholder='..') / (name='..') read fine unquoted.
    return name.startsWith("(") ? `the ${kind} ${name}` : `the ${kind} "${name}"`;
  }
  if (target.nth != null) {
    const region = REGION_EN[target.regionKey ?? "other"] ?? "other";
    return `the ${ordinal(target.nth)} ${kind} in the ${region} region`;
  }
  return `the ${kind}`;
}

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

function safeOriginOf(url: string): string {
  try {
    const o = new URL(url).origin;
    return !o || o === "null" ? url : o;
  } catch {
    return url;
  }
}

export function serialize(
  actions: RecordedAction[],
  _tabRegistry: TabRegistry = {},
): SerializeResult {
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

  const seenRefs = new Set<number>();
  let prevRef: number | undefined;

  actions.forEach((action, idx) => {
    const stepN = idx + 1;
    const ref = action.tabRef;
    if (ref !== undefined && idx > 0 && ref !== prevRef) {
      const origin = escapeUntrustedWrappers(safeOriginOf(action.url));
      lines.push(
        seenRefs.has(ref)
          ? STEP_TEMPLATES.switchTab(origin)
          : STEP_TEMPLATES.spawnTab(origin),
      );
    }
    if (ref !== undefined) {
      seenRefs.add(ref);
      prevRef = ref;
    }
    const targetExpr = describeTargetEn(action.target);
    const tool = ACTION_TO_TOOL[action.type];
    if (tool) tools.add(tool);

    let line: string;
    switch (action.type) {
      case "click":
        line =
          action.checked === undefined
            ? STEP_TEMPLATES.click(stepN, targetExpr)
            : action.checked
              ? STEP_TEMPLATES.check(stepN, targetExpr)
              : STEP_TEMPLATES.uncheck(stepN, targetExpr);
        break;
      case "submit":
        line = STEP_TEMPLATES.submit(stepN, targetExpr);
        break;
      case "type": {
        const valueExpr = renderValueExpr(action, params);
        line = STEP_TEMPLATES.type(stepN, targetExpr, valueExpr);
        break;
      }
      case "select": {
        const valueExpr = renderValueExpr(action, params);
        line = STEP_TEMPLATES.select(stepN, targetExpr, valueExpr);
        break;
      }
      case "scroll":
        line = STEP_TEMPLATES.scroll(stepN, action.direction ?? "down", action.value);
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
      line += " [possibly unstable]";
    }
    if (action.fromPopup) {
      line += " (This item is in a popup menu/dropdown; you may need to hover or click its trigger to reveal it first.)";
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
