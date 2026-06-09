export interface TextToolInvocation {
  id: string;
  name: string;
  args: unknown;
}

function readQuotedValue(src: string, start: number): { value: string; end: number } | null {
  const quote = src[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      value += ch;
      if (i + 1 < src.length) {
        value += src[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
  }
  return null;
}

function readJsonObjectValue(src: string, start: number): { value: string; end: number } | null {
  if (src[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { value: src.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

function readAttributeValue(src: string, attr: string): string | null {
  const match = new RegExp(`\\b${attr}\\s*=\\s*`).exec(src);
  if (!match || match.index == null) return null;
  const start = match.index + match[0].length;
  const quoted = readQuotedValue(src, start);
  if (quoted) return quoted.value;
  const object = readJsonObjectValue(src, start);
  if (object) return object.value;
  const bare = /^[^\s/>]+/.exec(src.slice(start));
  return bare?.[0] ?? null;
}

export function parseTextToolInvocations(text: string): TextToolInvocation[] {
  const trimmed = text.trim();
  if (!/^<tool_invocation\b[\s\S]*\/>$/.test(trimmed)) return [];
  if (trimmed.slice(0, -2).includes("/>")) return [];

  const name = readAttributeValue(trimmed, "name");
  const argsText = readAttributeValue(trimmed, "arguments");
  if (!name || argsText == null) return [];

  let args: unknown;
  try {
    args = JSON.parse(argsText);
  } catch {
    return [];
  }

  return [{ id: `text_tool_${crypto.randomUUID()}`, name, args }];
}
