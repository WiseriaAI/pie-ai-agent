# Output File Card 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `save_to_downloads` 即调即下，改成 `output_file` 产出一张侧栏文件卡片，由用户点击下载（弹"另存为"自选位置）。

**Architecture:** 工具调用只把文本产物存进 SW 的 in-memory `output-cache`（仿 `image-cache`，不持久化），并经 port 推一条 `file-output` 消息让 panel 渲染 `<FileOutputCard>`。用户点下载 → panel 经 port 发 `download-output` → SW 查缓存 → `chrome.downloads.download({ saveAs:true })`；缓存 miss 回 `file-output-result{status:"expired"}` 让卡片切禁用态。

**Tech Stack:** Chrome MV3、React 19 + TS、vitest + happy-dom、chrome.downloads、per-session `chrome.runtime.connect` port。

**Spec:** `docs/specs/2026-06-07-output-file-card-download.md` ｜ **Paper 原型:** `Pie Frontend` · 画板「NEW — Output File Card · Light + Dark」

---

## 文件结构与职责

| 文件 | 职责 | 任务 |
|---|---|---|
| `src/background/output-cache.ts`（新） | in-memory 产物缓存 + LRU + 驱逐 API | 1 |
| `src/lib/dom-actions/types.ts`（改） | `ActionResult` 加 `fileOutput?` 字段 | 2 |
| `src/lib/files/mime-label.ts`（新） | mime → 友好大写标签 + 字节 → 人类可读大小 | 2 |
| `src/lib/agent/tools/files.ts`（改） | `saveToDownloadsTool` → `buildOutputFileTool`（依赖注入 sessionId+store） | 3 |
| `src/lib/agent/tools/files.test.ts`（改） | 重写测试到 `output_file` 新语义 | 3 |
| `src/lib/agent/tool-names.ts`（改） | 注册 `output_file` = read 类，移除 `save_to_downloads` | 4 |
| `src/lib/agent/tools.ts`（改） | `LOCAL_FILE_TOOLS` 只剩 `readLocalFileTool` | 4 |
| `src/types/messages.ts`（改） | `FileOutputMessage` / `FileOutputResultMessage` 并入 union；`DisplayMessage` 加 `file-output` 变体 | 5 |
| `src/lib/agent/loop.ts`（改） | 构建+注册 `outputFileTool`；emitStep 后按需 emit `file-output` | 6 |
| `src/sidepanel/components/FileOutputCard.tsx`（新） | 卡片 UI（idle/busy/expired 三态） | 7 |
| `src/sidepanel/hooks/useSession/port-handlers.ts`（改） | 处理 `file-output`（建卡）+ `file-output-result`（resolve 下载 promise） | 8 |
| `src/sidepanel/hooks/useSession/*`（改） | `downloadOutput(artifactId): Promise<DownloadResult>` 往返 | 8 |
| `src/sidepanel/components/Chat.tsx`（改） | buildSegments 处理 `file-output`，渲染 `<FileOutputCard>` | 9 |
| `src/background/index.ts`（改） | port 路由 `download-output` → chrome.downloads；wire output-cache 驱逐 | 10 |
| `src/lib/i18n/dictionaries/{en,zh-CN}.ts`（改） | 卡片文案 key | 11 |
| `docs/release-notes/`（新） | 用户可见 changelog | 12 |

**契约（贯穿全计划，命名以此为准）：**

```ts
// 存于 output-cache 的产物
interface FileArtifact {
  id: string; sessionId: string; filename: string; mime: string;
  content: string; byteLength: number; addedAt: number;
}
// ActionResult 新字段（不含 content/preview —— 见 spec §5，卡片无正文预览）
type FileOutputExtras = { id: string; filename: string; mime: string; size: number };
// SW→panel 建卡
interface FileOutputMessage { type: "file-output"; sessionId: string; artifactId: string; filename: string; mime: string; size: number; }
// SW→panel 下载结果（resolve panel 端 pending promise）
interface FileOutputResultMessage { type: "file-output-result"; sessionId: string; artifactId: string; status: "ok" | "expired" | "error"; }
// panel→SW 触发下载（out-of-band port 消息，不进 PortMessageToWorker union）
//   { type: "download-output"; artifactId: string }   // sessionId 由 port 派生
```

---

## Task 1: output-cache（in-memory 产物缓存）

**Files:**
- Create: `src/background/output-cache.ts`
- Test: `src/background/output-cache.test.ts`

照搬 `src/background/image-cache.ts` 的结构（LRU + 4 路 evict + `_resetForTests`），但用字节预算 + 数量上限按 artifact 计（无 userTurn 概念）。

- [ ] **Step 1: 写失败测试**

```ts
// src/background/output-cache.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  addArtifact, getArtifact, evictSession, evictAllOnSWStartup,
  evictOnSetActive, evictByInFlightSet, _resetForTests, _getCacheSessionCount,
} from "./output-cache";
import type { FileArtifact } from "./output-cache";

function mk(id: string, sessionId: string, bytes = 100, addedAt = 1): FileArtifact {
  return { id, sessionId, filename: `pie/${id}.md`, mime: "text/markdown", content: "x".repeat(bytes), byteLength: bytes, addedAt };
}

describe("output-cache", () => {
  beforeEach(() => _resetForTests());

  it("stores and retrieves by (sessionId, id)", () => {
    addArtifact("s1", mk("a", "s1"));
    expect(getArtifact("s1", "a")?.filename).toBe("pie/a.md");
    expect(getArtifact("s1", "missing")).toBeUndefined();
    expect(getArtifact("s2", "a")).toBeUndefined();
  });

  it("LRU drops oldest artifact when byte budget exceeded", () => {
    const big = 6 * 1024 * 1024; // 6MB each, budget 10MB
    addArtifact("s1", mk("old", "s1", big, 1));
    addArtifact("s1", mk("new", "s1", big, 2));
    expect(getArtifact("s1", "old")).toBeUndefined();
    expect(getArtifact("s1", "new")).toBeDefined();
  });

  it("(a) evictSession only drops the named session", () => {
    addArtifact("s1", mk("a", "s1")); addArtifact("s2", mk("b", "s2"));
    evictSession("s1");
    expect(getArtifact("s1", "a")).toBeUndefined();
    expect(getArtifact("s2", "b")).toBeDefined();
  });

  it("(b) evictAllOnSWStartup wipes everything", () => {
    addArtifact("s1", mk("a", "s1")); addArtifact("s2", mk("b", "s2"));
    evictAllOnSWStartup();
    expect(_getCacheSessionCount()).toBe(0);
  });

  it("(c) evictOnSetActive keeps only the newly active session", () => {
    addArtifact("s1", mk("a", "s1")); addArtifact("s2", mk("b", "s2"));
    evictOnSetActive("s2");
    expect(getArtifact("s1", "a")).toBeUndefined();
    expect(getArtifact("s2", "b")).toBeDefined();
  });

  it("(d) evictByInFlightSet drops only the listed sessions", () => {
    addArtifact("s1", mk("a", "s1")); addArtifact("s2", mk("b", "s2"));
    evictByInFlightSet(["s1"]);
    expect(getArtifact("s1", "a")).toBeUndefined();
    expect(getArtifact("s2", "b")).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm test src/background/output-cache.test.ts` — 预期 FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
// src/background/output-cache.ts
// In-memory file artifact cache for the output_file tool. Mirrors
// image-cache.ts: per-session, LRU on a byte budget + count cap, evicted on
// task end / SW restart / session switch / panel disconnect. NOT persisted —
// SW idle/restart drops everything (spec §2: task/SW-lifetime only).

export interface FileArtifact {
  id: string;
  sessionId: string;
  filename: string; // already sanitized "pie/…"
  mime: string;
  content: string;
  byteLength: number;
  addedAt: number;
}

const SESSION_BYTE_BUDGET = 10 * 1024 * 1024; // 10 MB/session
const SESSION_COUNT_BUDGET = 20;              // ≤20 artifacts/session

const cache = new Map<string, FileArtifact[]>();

export function addArtifact(sessionId: string, a: FileArtifact): void {
  const list = cache.get(sessionId) ?? [];
  list.push(a);
  cache.set(sessionId, list);
  enforceLRU(sessionId);
}

export function getArtifact(sessionId: string, id: string): FileArtifact | undefined {
  return (cache.get(sessionId) ?? []).find((a) => a.id === id);
}

/** Drop oldest artifacts (smallest addedAt) until both bounds satisfied. */
function enforceLRU(sessionId: string): void {
  const list = cache.get(sessionId);
  if (!list) return;
  while (list.length > 0) {
    const totalBytes = list.reduce((s, a) => s + a.byteLength, 0);
    if (totalBytes <= SESSION_BYTE_BUDGET && list.length <= SESSION_COUNT_BUDGET) break;
    let oldestIdx = 0;
    for (let i = 1; i < list.length; i++) if (list[i].addedAt < list[oldestIdx].addedAt) oldestIdx = i;
    list.splice(oldestIdx, 1);
  }
  if (list.length === 0) cache.delete(sessionId);
}

// ── evict API (mirrors image-cache 4-path) ──────────────────────────────────
export function evictSession(sessionId: string): void { cache.delete(sessionId); }
export function evictAllOnSWStartup(): void { cache.clear(); }
export function evictOnSetActive(newActiveSessionId: string): void {
  for (const sid of [...cache.keys()]) if (sid !== newActiveSessionId) cache.delete(sid);
}
export function evictByInFlightSet(sessionIds: Iterable<string>): void {
  for (const sid of sessionIds) cache.delete(sid);
}

export function _resetForTests(): void { cache.clear(); }
export function _getCacheSessionCount(): number { return cache.size; }
```

- [ ] **Step 4: 跑测试确认通过** — `pnpm test src/background/output-cache.test.ts` — 预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/output-cache.ts src/background/output-cache.test.ts
git commit -m "feat(output-cache): in-memory file artifact cache with LRU + evict paths"
```

---

## Task 2: ActionResult.fileOutput 字段 + mime-label 工具

**Files:**
- Modify: `src/lib/dom-actions/types.ts`
- Create: `src/lib/files/mime-label.ts`
- Test: `src/lib/files/mime-label.test.ts`

- [ ] **Step 1: 给 ActionResult 加字段**（无需测试，类型变更）

```ts
// src/lib/dom-actions/types.ts
export interface ActionResult {
  success: boolean;
  observation?: string;
  error?: string;
  /**
   * output_file — structured artifact handed to the panel so it can render a
   * download card. Present only on a successful output_file call. Wire-only:
   * loop.ts turns this into a `file-output` port message. Full content lives
   * in the SW output-cache, NOT here.
   */
  fileOutput?: { id: string; filename: string; mime: string; size: number };
}
```

- [ ] **Step 2: 写 mime-label 失败测试**

```ts
// src/lib/files/mime-label.test.ts
import { describe, it, expect } from "vitest";
import { mimeLabel, humanSize } from "./mime-label";

describe("mimeLabel", () => {
  it("maps known mimes to friendly uppercase labels", () => {
    expect(mimeLabel("text/markdown")).toBe("MARKDOWN");
    expect(mimeLabel("application/json")).toBe("JSON");
    expect(mimeLabel("text/csv")).toBe("CSV");
    expect(mimeLabel("text/plain")).toBe("TEXT");
    expect(mimeLabel("application/xml")).toBe("XML");
  });
  it("falls back to the subtype uppercased", () => {
    expect(mimeLabel("text/x-python")).toBe("X-PYTHON");
    expect(mimeLabel("")).toBe("FILE");
  });
});

describe("humanSize", () => {
  it("formats bytes", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(12_300)).toBe("12.0 KB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
```

- [ ] **Step 3: 跑测试确认失败** — `pnpm test src/lib/files/mime-label.test.ts` — 预期 FAIL。

- [ ] **Step 4: 写实现**

```ts
// src/lib/files/mime-label.ts
const LABELS: Record<string, string> = {
  "text/markdown": "MARKDOWN",
  "text/plain": "TEXT",
  "text/csv": "CSV",
  "application/json": "JSON",
  "application/xml": "XML",
  "text/xml": "XML",
  "application/x-ndjson": "NDJSON",
};

/** mime → short uppercase label for the file card meta line. */
export function mimeLabel(mime: string): string {
  if (!mime) return "FILE";
  const known = LABELS[mime.toLowerCase()];
  if (known) return known;
  const sub = mime.split("/")[1]?.split(";")[0]?.trim();
  return sub ? sub.toUpperCase() : "FILE";
}

/** bytes → "12.0 KB" style human size. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
```

- [ ] **Step 5: 跑测试确认通过** — `pnpm test src/lib/files/mime-label.test.ts` — 预期 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/lib/dom-actions/types.ts src/lib/files/mime-label.ts src/lib/files/mime-label.test.ts
git commit -m "feat(files): ActionResult.fileOutput field + mime-label/humanSize helpers"
```

---

## Task 3: output_file 工具（依赖注入，替换 saveToDownloadsTool）

**Files:**
- Modify: `src/lib/agent/tools/files.ts:10-74,162`
- Modify: `src/lib/agent/tools/files.test.ts`

`output_file` 需要 `sessionId` 与 `store` 写 output-cache，故照 `buildRequestLocalFileTool` 依赖注入，不再是静态 tool。**保留全部校验**（`sanitizeDownloadName` / `SAFE_MIME` / `MAX_CONTENT_BYTES`）。

- [ ] **Step 1: 重写 files.test.ts 的下载部分**（删除整个 `describe("save_to_downloads tool")` 块，替换为）

```ts
// src/lib/agent/tools/files.test.ts —— 顶部 import 改为：
import { buildOutputFileTool, readLocalFileTool, buildRequestLocalFileTool } from "./files";
import type { FileArtifact } from "@/background/output-cache";

// （readLocalFile / request_local_file 既有测试保持不变）

describe("output_file tool", () => {
  const ctx = { tabId: 1 } as Parameters<ReturnType<typeof buildOutputFileTool>["handler"]>[1];
  function build() {
    const stored: FileArtifact[] = [];
    const tool = buildOutputFileTool({ sessionId: "s1", store: (a) => stored.push(a) });
    return { tool, stored };
  }

  it("is named output_file and read-class-shaped (no save_as param)", () => {
    const { tool } = build();
    expect(tool.name).toBe("output_file");
    expect(JSON.stringify(tool.parameters)).not.toContain("save_as");
  });

  it("stores an artifact and returns fileOutput (does NOT call chrome.downloads)", async () => {
    const dl = vi.fn();
    // @ts-expect-error test global
    globalThis.chrome = { downloads: { download: dl } };
    const { tool, stored } = build();
    const r = await tool.handler({ filename: "report.md", content: "# hi", mime: "text/markdown" }, ctx);
    expect(r.success).toBe(true);
    expect(dl).not.toHaveBeenCalled();
    expect(stored).toHaveLength(1);
    expect(stored[0].filename).toBe("pie/report.md");
    expect(stored[0].content).toBe("# hi");
    expect(r.fileOutput).toMatchObject({ filename: "pie/report.md", mime: "text/markdown", size: stored[0].byteLength });
    expect(r.fileOutput?.id).toBe(stored[0].id);
  });

  it("rejects content over 5MB before storing", async () => {
    const { tool, stored } = build();
    const r = await tool.handler({ filename: "big.txt", content: "x".repeat(5 * 1024 * 1024 + 1) }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/content_too_large/);
    expect(stored).toHaveLength(0);
  });

  it("forces text/plain for non-allowlisted mime (e.g. text/html)", async () => {
    const { tool, stored } = build();
    await tool.handler({ filename: "a.html", content: "<b>hi</b>", mime: "text/html" }, ctx);
    expect(stored[0].mime).toBe("text/plain");
  });

  it("sanitizes path traversal to pie/untitled.txt", async () => {
    const { tool, stored } = build();
    const r = await tool.handler({ filename: "../..", content: "hi" }, ctx);
    expect(r.success).toBe(true);
    expect(stored[0].filename).toBe("pie/untitled.txt");
  });

  it("requires content", async () => {
    const { tool } = build();
    const r = await tool.handler({ filename: "a.txt" }, ctx);
    expect(r.success).toBe(false);
  });
});
```

> 注：`files.test.ts` 顶部需要 `import { vi } from "vitest"`（若尚未导入）。

- [ ] **Step 2: 跑测试确认失败** — `pnpm test src/lib/agent/tools/files.test.ts` — 预期 FAIL（`buildOutputFileTool` 不存在）。

- [ ] **Step 3: 改 files.ts**

把 `files.ts:10-74` 的 `SaveArgs` 接口 + `saveToDownloadsTool` 整段替换为下面的 `buildOutputFileTool`（`SAFE_MIME` / `MAX_CONTENT_BYTES` 常量保留不动；`sanitizeDownloadName` import 保留）：

```ts
import type { FileArtifact } from "@/background/output-cache";

interface OutputArgs { filename?: string; content?: string; mime?: string; }

export interface OutputFileDeps {
  sessionId: string;
  store: (a: FileArtifact) => void;
}

/**
 * output_file — produce a downloadable text artifact. Unlike the old
 * save_to_downloads (which wrote to disk immediately), this only stores the
 * content in the SW output-cache and returns `fileOutput` so the panel can
 * render a card; the actual chrome.downloads call happens later when the user
 * clicks the card's download button (SW routes `download-output`). Dep-injected
 * with sessionId + store because it needs runtime state — NOT in the static
 * LOCAL_FILE_TOOLS array (mirrors buildRequestLocalFileTool).
 */
export function buildOutputFileTool(deps: OutputFileDeps): Tool {
  return {
    name: "output_file",
    description:
      "Produce a text file (report, code, markdown, CSV, JSON) and present it to the user " +
      "as a downloadable card in the side panel. The user decides whether to download it and " +
      "picks the save location themselves — you do NOT save to disk directly, so do not assume " +
      "the file was saved. Cannot write to arbitrary absolute paths; the name is always under pie/.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: 'Relative file name, e.g. "report.md" or "notes/summary.md". Always presented under pie/.' },
        content: { type: "string", description: "The text content of the file." },
        mime: { type: "string", description: 'MIME type. Default "text/plain".' },
      },
      required: ["filename", "content"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as OutputArgs;
      if (typeof a.content !== "string") return { success: false, error: "content is required (string)" };
      if (a.content.length > MAX_CONTENT_BYTES) return { success: false, error: `content_too_large: max ${MAX_CONTENT_BYTES / 1024 / 1024}MB` };
      const rawFilename = typeof a.filename === "string" ? a.filename : "";
      const filename = sanitizeDownloadName(rawFilename);
      const mime = typeof a.mime === "string" && SAFE_MIME.test(a.mime) ? a.mime : "text/plain";
      const byteLength = new Blob([a.content]).size;
      const id = crypto.randomUUID();
      deps.store({ id, sessionId: deps.sessionId, filename, mime, content: a.content, byteLength, addedAt: Date.now() });
      const renameNote =
        filename === "pie/untitled.txt" && rawFilename !== "pie/untitled.txt"
          ? " (filename was sanitized to untitled.txt)"
          : "";
      return {
        success: true,
        observation:
          `Presented "${filename}" to the user as a downloadable card in the side panel. ` +
          `The user will choose whether to download it and where to save it. ` +
          `Do not assume it has been saved.${renameNote}`,
        fileOutput: { id, filename, mime, size: byteLength },
      };
    },
  };
}
```

然后改 `files.ts:162`：

```ts
export const LOCAL_FILE_TOOLS: Tool[] = [readLocalFileTool];
```

- [ ] **Step 4: 跑测试确认通过** — `pnpm test src/lib/agent/tools/files.test.ts` — 预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools/files.ts src/lib/agent/tools/files.test.ts
git commit -m "feat(output_file): replace save_to_downloads with dep-injected output_file tool"
```

---

## Task 4: tool-names 注册 + tools.ts 装配

**Files:**
- Modify: `src/lib/agent/tool-names.ts:88-95,199-202`
- Modify: `src/lib/agent/tools.ts`（已随 Task 3 改 `LOCAL_FILE_TOOLS`，本任务确认装配仍正确）

> 构建期不变量：`output_file` 必须出现在 `KNOWN_BUILT_IN_TOOL_NAMES` 且在 `TOOL_CLASSES` 声明 class，否则模块加载 throw。

- [ ] **Step 1: 改 tool-names.ts** — `LOCAL_FILE_TOOL_NAMES`（行 88-95）：

```ts
// Local file I/O tools.
//   output_file — read (produces an in-memory artifact + side-panel card;
//     no disk write at call time — the user triggers download later).
//   read_local_file / request_local_file — read.
export const LOCAL_FILE_TOOL_NAMES = [
  "output_file",
  "read_local_file",
  "request_local_file",
] as const;
```

`TOOL_CLASSES`（行 199-202）：

```ts
  // Local file I/O
  output_file: "read",
  read_local_file: "read",
  request_local_file: "read",
```

- [ ] **Step 2: 跑工具名相关测试 + typecheck**

Run: `pnpm test src/lib/agent && pnpm typecheck`
Expected: PASS（无 `save_to_downloads` 残留报错）。`tools.ts:309` 的 `...LOCAL_FILE_TOOLS` 现在只 spread `readLocalFileTool`，编译通过。

- [ ] **Step 3: Commit**

```bash
git add src/lib/agent/tool-names.ts
git commit -m "feat(tool-names): register output_file (read-class), drop save_to_downloads"
```

---

## Task 5: 消息类型

**Files:**
- Modify: `src/types/messages.ts:191-248,519-536`（DisplayMessage、PortMessageToPanel）

- [ ] **Step 1: 在 messages.ts 加两个接口**（放在 `PdfNeedsFileAccessMessage`（行 500-503）附近）

```ts
/** output_file — SW tells the panel to render a download card. */
export interface FileOutputMessage {
  type: "file-output";
  artifactId: string;
  filename: string;
  mime: string;
  size: number;
  /** M2-U2 — session routing. */
  sessionId: string;
}

/** output_file — SW replies to a panel download-output request so the panel
 *  can resolve its pending promise (ok = chrome.downloads started; expired =
 *  artifact evicted from cache; error = chrome.downloads threw). */
export interface FileOutputResultMessage {
  type: "file-output-result";
  artifactId: string;
  status: "ok" | "expired" | "error";
  sessionId: string;
}
```

- [ ] **Step 2: 并入 `PortMessageToPanel`**（行 519-536 末尾）

```ts
  | PdfNeedsFileAccessMessage         // PDF local file access card
  | FileOutputMessage                 // output_file download card
  | FileOutputResultMessage;          // output_file download result
```

- [ ] **Step 3: `DisplayMessage` 加 file-output 变体**（行 191-248 union 末尾，在 session-confirm 变体后追加）

```ts
  | {
      /** output_file — download card. Full content lives in the SW
       *  output-cache; this carries only display fields + the artifactId the
       *  panel sends back via download-output. */
      role: "file-output";
      artifactId: string;
      filename: string;
      mime: string;
      size: number;
    };
```

- [ ] **Step 4: typecheck** — `pnpm typecheck` — 预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/types/messages.ts
git commit -m "feat(messages): file-output + file-output-result port messages, DisplayMessage variant"
```

---

## Task 6: loop.ts 注册工具 + emit file-output

**Files:**
- Modify: `src/lib/agent/loop.ts`（import 区、1554-1561、2099-2107 后）

- [ ] **Step 1: import**（loop.ts 顶部 import 区，与既有 tool import 同组）

```ts
import { buildOutputFileTool } from "./tools/files";
import { addArtifact } from "@/background/output-cache";
```

- [ ] **Step 2: 构建并注册工具**（loop.ts:1554-1561）— 在 `requestLocalFileTool` 之后加：

```ts
      const requestLocalFileTool = buildRequestLocalFileTool({
        sessionId,
        requestFile: requestLocalFileFromPanel,
      });
      const outputFileTool = buildOutputFileTool({
        sessionId,
        store: (a) => addArtifact(sessionId, a),
      });
      const allTools = filterToolsByVision(
        [...BUILT_IN_TOOLS, ...mouseTools, ...keyboardTools, ...editorTools, requestLocalFileTool, outputFileTool],
        modelConfig.vision,
      );
```

- [ ] **Step 3: emit file-output**（loop.ts:2099-2107，在通用 tool 的 `emitStep({...})` 调用之后追加）

```ts
      emitStep({
        type: "agent-step",
        stepIndex,
        tool: tc.name,
        args: redactArgsForPanel(tc.name, tc.args),
        resolvedElement,
        status: result.success ? "ok" : "error",
        observation,
      });

      // output_file — hand the panel a download card. The agent-step above
      // keeps the call visible in the step stream; this drives the card.
      if (result.fileOutput) {
        port.postMessage(
          withSession(
            {
              type: "file-output",
              artifactId: result.fileOutput.id,
              filename: result.fileOutput.filename,
              mime: result.fileOutput.mime,
              size: result.fileOutput.size,
            },
            sessionId,
          ),
        );
      }
```

- [ ] **Step 4: typecheck + 现有 loop 测试** — `pnpm typecheck && pnpm test src/lib/agent/loop` — 预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(loop): register output_file tool + emit file-output card message"
```

---

## Task 7: FileOutputCard 组件

**Files:**
- Create: `src/sidepanel/components/FileOutputCard.tsx`
- Test: `src/sidepanel/components/FileOutputCard.test.tsx`

视觉规格见 spec §5（紧凑单行卡，下载按钮内联同一行，无正文预览）。三态：`idle` / `busy`（点击后等待）/ `expired`（缓存丢失）。`onDownload` 返回 Promise，resolve 出结果驱动状态切换。Tailwind class 复用现有 token（`bg-surface`/`border-line`/`text-fg-1` 等，命名以仓库现有 class 为准 —— 实现时参考 `AgentStepLine.tsx` / `SessionConfirmCard.tsx` 用到的 token class）。

- [ ] **Step 1: 写组件测试**

```tsx
// src/sidepanel/components/FileOutputCard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FileOutputCard } from "./FileOutputCard";

describe("FileOutputCard", () => {
  it("renders filename + type·size", () => {
    render(<FileOutputCard artifactId="a" filename="pie/report.md" mime="text/markdown" size={12300} onDownload={vi.fn()} />);
    expect(screen.getByText("report.md")).toBeTruthy();
    expect(screen.getByText(/MARKDOWN/)).toBeTruthy();
    expect(screen.getByText(/12\.0 KB/)).toBeTruthy();
  });

  it("calls onDownload with artifactId when clicked", async () => {
    const onDownload = vi.fn().mockResolvedValue({ status: "ok" });
    render(<FileOutputCard artifactId="a7" filename="pie/x.md" mime="text/markdown" size={10} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith("a7"));
  });

  it("switches to expired state when download resolves expired", async () => {
    const onDownload = vi.fn().mockResolvedValue({ status: "expired" });
    render(<FileOutputCard artifactId="a" filename="pie/x.md" mime="text/markdown" size={10} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true));
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm test src/sidepanel/components/FileOutputCard.test.tsx` — 预期 FAIL。

- [ ] **Step 3: 写组件**（class 名按仓库现有 token；下面用语义占位 class，实现时对齐 `AgentStepLine`/`SessionConfirmCard` 实际用的 class）

```tsx
// src/sidepanel/components/FileOutputCard.tsx
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { mimeLabel, humanSize } from "@/lib/files/mime-label";

export interface DownloadResult { status: "ok" | "expired" | "error"; }

interface Props {
  artifactId: string;
  filename: string; // "pie/report.md"
  mime: string;
  size: number;
  onDownload: (artifactId: string) => Promise<DownloadResult>;
}

function basename(name: string): string {
  const parts = name.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

const DocIcon = ({ className }: { className?: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
  </svg>
);
const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
  </svg>
);

export function FileOutputCard({ artifactId, filename, mime, size, onDownload }: Props) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "busy" | "expired">("idle");
  const disabled = status !== "idle";

  async function handleClick() {
    if (disabled) return;
    setStatus("busy");
    const r = await onDownload(artifactId);
    setStatus(r.status === "expired" ? "expired" : "idle");
  }

  const dimmed = status === "expired";
  return (
    <div className={`flex flex-row items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 ${dimmed ? "opacity-60" : ""}`}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-field text-fg-3">
        <DocIcon />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="truncate text-[14px] font-medium text-fg-1">{basename(filename)}</div>
        <div className="font-mono text-[11px] text-fg-2">
          {dimmed ? t("chat.output.expired") : `${mimeLabel(mime)} · ${humanSize(size)}`}
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={handleClick}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-bg disabled:opacity-50"
      >
        <DownloadIcon />
        {t("chat.output.download")}
      </button>
    </div>
  );
}
```

> 实现注意：`bg-surface`/`border-line`/`bg-field`/`text-fg-1/2/3`/`bg-accent`/`text-bg` 这些 class 须替换为仓库 Tailwind 实际 token 名（打开 `AgentStepLine.tsx` 与 `SessionConfirmCard.tsx` 确认现有 class，保持一致）。`useT`/`@/lib/i18n` 已是仓库既有 import（见 LocalFileRequestCard）。

- [ ] **Step 4: 跑测试确认通过** —（先做 Task 11 的 i18n key 或临时让 `t()` 返回 key）`pnpm test src/sidepanel/components/FileOutputCard.test.tsx` — 预期 PASS。

> 依赖说明：本任务用到 `chat.output.download` / `chat.output.expired` 两个 i18n key（Task 11 添加）。若先跑测试，`useT` 缺 key 会回退返回 key 字符串，断言用的是 `/MARKDOWN/`、`/12\.0 KB/`、disabled 状态，不依赖具体文案，故可独立通过。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/FileOutputCard.tsx src/sidepanel/components/FileOutputCard.test.tsx
git commit -m "feat(sidepanel): FileOutputCard component (idle/busy/expired)"
```

---

## Task 8: panel 接收卡片 + 下载往返

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts:138`（加分支）
- Modify: `src/sidepanel/hooks/useSession/`（暴露 `downloadOutput`，pending resolver map）

> port-handlers 形态见现有 `agent-step` / `session-confirm-request` 分支。`downloadOutput` 往返镜像 SW 端 `local-file-response` 的 pending-resolver 模式，但方向相反（panel 发起、SW 回 `file-output-result`）。

- [ ] **Step 1: 在 port-handlers.ts 的 handleMessage 加 file-output 分支**（与 session-confirm-request 分支同级）

```ts
if (msg.type === "file-output") {
  const prev = slotsRef.current.get(id);
  const baseMessages = prev?.messages ?? [];
  // de-dup by artifactId (a re-emit shouldn't double-card)
  if (baseMessages.some((m) => m.role === "file-output" && m.artifactId === msg.artifactId)) return;
  const entry: DisplayMessage = {
    role: "file-output",
    artifactId: msg.artifactId,
    filename: msg.filename,
    mime: msg.mime,
    size: msg.size,
  };
  patchSlot(id, { messages: [...baseMessages, entry] });
  return;
}

if (msg.type === "file-output-result") {
  resolveDownload(msg.artifactId, { status: msg.status });
  return;
}
```

- [ ] **Step 2: 实现 pending-resolver + downloadOutput**

在 useSession 模块新增一个模块级（或 ref 持有的）pending map 与两个函数。`port` 是 panel 已持有的 per-session port（见 Chat.tsx `port.postMessage` 用法）。

```ts
// pending download resolvers, keyed by artifactId
const pendingDownloads = new Map<string, (r: { status: "ok" | "expired" | "error" }) => void>();

export function resolveDownload(artifactId: string, r: { status: "ok" | "expired" | "error" }): void {
  const fn = pendingDownloads.get(artifactId);
  if (fn) { pendingDownloads.delete(artifactId); fn(r); }
}

// returned from useSession so Chat.tsx can pass it to <FileOutputCard onDownload>
function downloadOutput(artifactId: string): Promise<{ status: "ok" | "expired" | "error" }> {
  if (!port) return Promise.resolve({ status: "error" });
  return new Promise((resolve) => {
    pendingDownloads.set(artifactId, resolve);
    port.postMessage({ type: "download-output", artifactId });
    // safety timeout — if SW never replies (port died), fail to idle after 30s
    setTimeout(() => resolveDownload(artifactId, { status: "error" }), 30_000);
  });
}
```

> 实现注意：`pendingDownloads`/`resolveDownload` 必须与 port-handlers 同一模块作用域可见（与现有 hook 内部状态组织一致，按仓库 useSession 拆分方式放置；若 port-handlers 与 useSession 分文件，把 map + resolveDownload 放在共享处或经 ref 传入）。`downloadOutput` 须从 `useSession` 的返回对象暴露出去。`setTimeout` 用 `window.setTimeout`（panel 是 DOM 环境，非 SW），允许 `Date.now`/timers。

- [ ] **Step 3: typecheck + 现有 useSession 测试** — `pnpm typecheck && pnpm test src/sidepanel/hooks/useSession` — 预期 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/hooks/useSession
git commit -m "feat(sidepanel): receive file-output card + download round-trip via port"
```

---

## Task 9: Chat.tsx 渲染卡片

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx:53-83`（buildSegments）、`:1144-1193`（segment 渲染）、import 区

- [ ] **Step 1: buildSegments 不动**（`file-output` role ≠ `agent-step`，已自动走 `{ kind:"msg" }` 单独成段，打断 step 组）。**确认**：`buildSegments` 第一个 `if (m.role !== "agent-step")` 已覆盖 file-output。无需改 buildSegments。

- [ ] **Step 2: 在 segment 渲染处加分支**（Chat.tsx:1144-1193，`session-confirm` 分支之后、`return null` 之前）

```tsx
  if (msg.role === "file-output") {
    return (
      <div key={firstIndex} className="bubble-in">
        <FileOutputCard
          artifactId={msg.artifactId}
          filename={msg.filename}
          mime={msg.mime}
          size={msg.size}
          onDownload={session.downloadOutput}
        />
      </div>
    );
  }
```

- [ ] **Step 3: import**（Chat.tsx import 区，与其他卡片 import 同组）

```tsx
import { FileOutputCard } from "./FileOutputCard";
```

> `session.downloadOutput` 来自 Task 8 暴露的 useSession 返回值；`session` 是 Chat.tsx 已持有的 useSession 实例（与 `session.discardTask` 同源，见 session-confirm 分支）。

- [ ] **Step 4: typecheck + Chat 测试** — `pnpm typecheck && pnpm test src/sidepanel/components/Chat` — 预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Chat.tsx
git commit -m "feat(sidepanel): render FileOutputCard in chat stream"
```

---

## Task 10: SW 路由 download-output + 驱逐接线

**Files:**
- Modify: `src/background/index.ts`（import 区、`port.onMessage` out-of-band 区 ~1513、驱逐点 236 / 1557）

- [ ] **Step 1: import output-cache**（index.ts:77-79 image-cache import 旁）

```ts
import { getArtifact, evictAllOnSWStartup as evictOutputAllOnSWStartup, evictByInFlightSet as evictOutputByInFlightSet } from "./output-cache";
```

- [ ] **Step 2: 处理 download-output**（index.ts `port.onMessage` 里 `local-file-response` 分支之后，~行 1524）

```ts
  // output_file — panel asks SW to download a cached artifact. SW shows a
  // Save As dialog (saveAs:true) so the user picks the location; replies with
  // file-output-result so the panel resolves its pending promise.
  if (rawMsg.type === "download-output" && typeof (rawMsg as { artifactId?: unknown }).artifactId === "string") {
    const artifactId = (rawMsg as { artifactId: string }).artifactId;
    const art = getArtifact(portSessionId, artifactId);
    if (!art) {
      port.postMessage({ type: "file-output-result", artifactId, status: "expired", sessionId: portSessionId });
    } else {
      const url = `data:${art.mime};charset=utf-8,${encodeURIComponent(art.content)}`;
      chrome.downloads
        .download({ url, filename: art.filename, conflictAction: "uniquify", saveAs: true })
        .then(() => port.postMessage({ type: "file-output-result", artifactId, status: "ok", sessionId: portSessionId }))
        .catch((e) => {
          // user-cancelled Save As is not a real error — revert card to idle (ok)
          const msg = e instanceof Error ? e.message : String(e);
          const cancelled = /canceled|cancelled/i.test(msg);
          port.postMessage({ type: "file-output-result", artifactId, status: cancelled ? "ok" : "error", sessionId: portSessionId });
        });
    }
  }
```

> `portSessionId` 是该 port 绑定的可信 session（与 `handleLocalFileResponse(portSessionId, …)` 同源）。data: URL 构造与旧 save_to_downloads 一致（MV3 SW 无 `URL.createObjectURL`）。

- [ ] **Step 3: 接驱逐路径** — index.ts:236（SW 启动）`evictAllOnSWStartup();` 后加：

```ts
    evictOutputAllOnSWStartup();
```

index.ts:1557（panel disconnect）`evictByInFlightSet(sessionsToClose);` 后加：

```ts
    evictOutputByInFlightSet(sessionsToClose);
```

- [ ] **Step 4: typecheck + background 测试** — `pnpm typecheck && pnpm test src/background` — 预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/index.ts
git commit -m "feat(sw): route download-output to chrome.downloads (saveAs) + wire output-cache eviction"
```

---

## Task 11: i18n 文案

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`（`chat` 对象内）
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`（`chat` 对象内）

> 现有 `chat.files.*` 在 en.ts:140 / zh-CN.ts:141。新增同级 `chat.output.*`。

- [ ] **Step 1: en.ts** — 在 `chat` 对象内（`files: {…}` 旁）加：

```ts
    output: {
      download: "Download",
      expired: "Expired · ask the assistant to regenerate",
    },
```

- [ ] **Step 2: zh-CN.ts** — 对应加：

```ts
    output: {
      download: "下载",
      expired: "已过期 · 让助手重新生成",
    },
```

- [ ] **Step 3: typecheck + i18n 测试** — `pnpm typecheck && pnpm test src/lib/i18n` — 预期 PASS（两字典 key 形状一致）。

- [ ] **Step 4: 重跑卡片测试确认文案接上** — `pnpm test src/sidepanel/components/FileOutputCard.test.tsx` — 预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "feat(i18n): chat.output.download / chat.output.expired (en + zh)"
```

---

## Task 12: release note + 全门禁

**Files:**
- Create: `docs/release-notes/<next-version>.md`（沿用现有 release-notes 命名）

> 历史文档（`docs/release-notes/v0.18.0.md`、`docs/plans|specs/2026-05-29-local-file-io.md`）保留不改 —— 它们是历史档案。

- [ ] **Step 1: 写 release note**（中英双语，遵循 dual-readme 约定），要点：
  - `save_to_downloads` → `output_file`：不再静默落盘；模型产出文件后在侧栏显示卡片。
  - 用户点卡片下载按钮才下载，且必弹"另存为"自选位置。
  - 卡片内容只在任务/SW 存活期间有效，过期需让助手重新生成。

- [ ] **Step 2: 全量门禁**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS。`tool-names.ts` build-time invariant 不 throw（`output_file` 已声明 read class）；`pnpm build` 产物正常。

- [ ] **Step 3: 全仓确认无旧名残留（代码层）**

Run: `grep -rn "save_to_downloads\|saveToDownloads" src/`
Expected: **无输出**（仅 docs 历史档案可保留）。

- [ ] **Step 4: Commit**

```bash
git add docs/release-notes
git commit -m "docs(release-notes): output_file card + user-triggered download"
```

---

## 手动验证（合并前）

加载 `dist/` 到 Chrome，真机走一遍：
1. 让 agent 产出一个文件（如"把这页总结成 markdown 存成文件"）→ 侧栏出现文件卡片（文件名 + 类型·大小 + 下载按钮），**Downloads 目录无文件**。
2. 点下载 → 弹"另存为"，选位置 → 文件落到所选位置。
3. 另存为点取消 → 卡片回到可下载态，可重试。
4. 等 SW idle 回收（或 `chrome://serviceworker-internals` 停掉 SW）后点下载 → 卡片切「已过期」禁用态。
5. 切换 session / 重开 panel，行为符合"任务期间有效"语义。

---

## Self-Review（计划 vs spec）

- **spec §2 目标 1（卡片显示）** → Task 5/6/7/9 ✓
- **spec §2 目标 2（点击才下载）** → Task 7（onDownload）/8（往返）/10（SW 触发）✓
- **spec §2 目标 3（自选位置）** → Task 10（`saveAs:true`）✓
- **spec §2 非目标（不持久化/无预览/不碰图片链路/无历史面板）** → Task 1（in-memory）/7（无预览块）✓ 未引入 IndexedDB
- **spec §3 决策（改名 output_file / 删 save_as / read 类 / SW 触发 / in-memory）** → Task 3/4/10/1 ✓
- **spec §4 数据流** → Task 6（emit）/8（panel 收发）/10（SW 路由）✓
- **spec §5 卡片视觉 + 状态机** → Task 7 ✓（idle/busy/expired；ok/expired/error 结果映射）
- **spec §6 边界（expired/超限 fail/取消/重复点击/驱逐）** → Task 1/3/7/10 ✓
- **spec §7 改动清单 10 项** → Task 1-11 全覆盖 ✓
- **spec §8 测试点** → Task 1（cache LRU/evict）/3（handler 校验+结构）/10（路由命中/miss）/12（grep 无残留）✓
- **类型一致性**：`FileArtifact` / `FileOutputExtras{id,filename,mime,size}` / `FileOutputMessage` / `FileOutputResultMessage{status:"ok"|"expired"|"error"}` / `downloadOutput`/`resolveDownload` / `buildOutputFileTool({sessionId,store})` —— 全计划同名一致 ✓
