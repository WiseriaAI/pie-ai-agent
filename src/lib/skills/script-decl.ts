// capabilities.scripts 声明层（spec §4.4 Q6）。YAML 解析层保持 string[]（极简
// 解析器不动）；对象形以 JSON flow 语法写在列表项里（JSON 是合法 YAML）：
//   capabilities:
//     scripts:
//       - scripts/dedupe.js
//       - {"entry": "scripts/fetch.js", "network": ["api.example.com"]}
// string 简写 = 纯计算脚本；对象形 = 特权脚本（fs/network → daemon 路径，Slice 2b）。
// 坏声明按不存在处理：frontmatter 是用户内容，解析必须韧性，不 throw。

export interface ScriptDecl {
  entry: string;
  fs: boolean;
  network: string[];
}

export function parseScriptDecls(raw: unknown): ScriptDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptDecl[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (!s) continue;
    if (s.startsWith("{")) {
      try {
        const o = JSON.parse(s) as { entry?: unknown; fs?: unknown; network?: unknown };
        if (typeof o.entry !== "string" || !o.entry) continue;
        out.push({
          entry: o.entry,
          fs: o.fs === true,
          network: Array.isArray(o.network)
            ? o.network.filter((h): h is string => typeof h === "string")
            : [],
        });
      } catch {
        continue;
      }
    } else {
      out.push({ entry: s, fs: false, network: [] });
    }
  }
  return out;
}

export function findScriptDecl(decls: ScriptDecl[], entry: string): ScriptDecl | undefined {
  return decls.find((d) => d.entry === entry);
}

export function isPureCompute(d: ScriptDecl): boolean {
  return !d.fs && d.network.length === 0;
}
