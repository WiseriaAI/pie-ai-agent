# 本地文件读写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Pie 能从本地读取文件(文本/代码、PDF、图片)喂给 LLM,并把 LLM 产出写到本地下载目录。

**Architecture:** 三个能力分层落地 —— ①写出(`save_to_downloads`,SW 构造 `data:` URL 走 `chrome.downloads`);②`file://` 读取(`read_local_file`,SW `fetch(file://)`,PDF 复用现有 offscreen);③offscreen 新增按字节解析变体 `pdf:parse_bytes`;④Finder 弹窗选文件 + composer `+` 菜单统一为"附加文件" + `request_local_file`(SW↔panel human-in-loop)。四阶段各自独立可发布、可测试。

**Tech Stack:** Chrome Extension MV3, React 19 + TS, vitest + happy-dom, @testing-library/react. 现有可复用件:`Tool` 接口 + `BUILT_IN_TOOLS`、`tool-names.ts` read/write 分类、`untrusted-wrappers.ts` 双表、`offscreen-manager.ts` request/response bridge、`ImageAttachment` + Phase 5 vision 管线、`pdf:needs-file-access` + `PdfPermissionCard` 权限引导、CDP onboarding 的 SW↔panel 往返范式。

---

## 关键接口速查(实现前必读)

**`Tool`**(`src/lib/agent/types.ts`):
```ts
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  handler: (args: unknown, ctx: ToolHandlerContext) => Promise<ActionResult>;
}
interface ToolHandlerContext { tabId: number; /* + pinnedTabs?, appendPinnedTab?, setCurrentFocusTabId? ... */ }
```
**`ActionResult`**(`src/lib/dom-actions/types.ts`):`{ success: boolean; observation?: string; error?: string }`。

**Tool 实现范本**:`src/lib/agent/tools/pdf.ts`(offscreen 调用 + untrusted wrapper)、`src/lib/agent/tools/search.ts`(纯 SW handler + wrapper escape)。

**Untrusted wrapper 双表 invariant**(CLAUDE.md):新增 tag 必须同时进
- `UNTRUSTED_WRAPPER_TAGS`(`src/lib/agent/untrusted-wrappers.ts`)
- `WRAPPER_TAGS_LIST`(`src/lib/dom-actions/page-snapshot.ts`,行 44-52)
(`html-strip.ts` 的列表只覆盖页面 snapshot,PDF 类 tag 已不在其中 → 本地文件 tag 同样不需要。)

**Tool class invariant**(`src/lib/agent/tool-names.ts`):新增 tool 名必须进 `KNOWN_BUILT_IN_TOOL_NAMES`(行 86)且在 `TOOL_CLASSES`(行 138)声明 `read|write`,否则模块加载 throw。

**测试 chrome mock**:`src/test/setup.ts`(行 165 `runtime`、行 250 导出 `chromeMock`)。`chrome.downloads` / `chrome.extension.isAllowedFileSchemeAccess` 目前**没有** mock,Phase 1/2 需补。

---

## File Structure

| 文件 | 责任 | 阶段 |
|---|---|---|
| `src/lib/files/download-name.ts` (新) | `sanitizeDownloadName(name)` 纯函数:强制 `pie/` 前缀、剥离 `..`/绝对路径 | 1 |
| `src/lib/files/download-name.test.ts` (新) | 上者单测 | 1 |
| `src/lib/agent/tools/files.ts` (新) | `saveToDownloadsTool` / `readLocalFileTool` / `buildRequestLocalFileTool` + `LOCAL_FILE_TOOLS` | 1,2,4 |
| `src/lib/agent/tools/files.test.ts` (新) | 上者单测 | 1,2 |
| `src/lib/agent/tools.ts` (改) | import + 把本地文件 tool 并入 `BUILT_IN_TOOLS` | 1,2 |
| `src/lib/agent/tool-names.ts` (改) | `LOCAL_FILE_TOOL_NAMES` + `TOOL_CLASSES` 分类 | 1,2,4 |
| `manifest.json` (改) | `permissions` 加 `"downloads"` | 1 |
| `src/test/setup.ts` (改) | chrome mock 补 `downloads` + `extension.isAllowedFileSchemeAccess` | 1,2 |
| `src/lib/agent/untrusted-wrappers.ts` (改) | `UNTRUSTED_WRAPPER_TAGS` 加 `untrusted_local_file` | 2 |
| `src/lib/dom-actions/page-snapshot.ts` (改) | `WRAPPER_TAGS_LIST` 加 `untrusted_local_file` | 2 |
| `src/lib/file-read/classify.ts` (新) | `classifyFile(name, mime)` → `'text'|'pdf'|'image'|'unsupported'`;`MAX_FILE_BYTES` 常量 | 2,4 |
| `src/lib/file-read/classify.test.ts` (新) | 上者单测 | 2,4 |
| `src/background/offscreen-manager.ts` (改) | `OffscreenRequest` 加 `pdf:parse_bytes` | 3 |
| `src/offscreen/pdf-parser.ts` (改) | `handleMessage` 支持 `pdf:parse_bytes`(按字节、内容寻址缓存) | 3 |
| `src/offscreen/pdf-parser.test.ts` (改) | 上者单测 | 3 |
| `src/lib/files/types.ts` (新) | `FileAttachment` 类型 | 4 |
| `src/lib/files/process-picked-file.ts` (新) | `processPickedFile(File)` → `ImageAttachment | FileAttachment | error` | 4 |
| `src/lib/files/process-picked-file.test.ts` (新) | 上者单测 | 4 |
| `src/lib/files/inject.ts` (新) | `fileAttachmentToWrapper(att)` → `<untrusted_local_file>` 字符串 | 4 |
| `src/lib/files/inject.test.ts` (新) | 上者单测 | 4 |
| `src/sidepanel/components/FileChip.tsx` (新) | 文本/PDF 附件 chip | 4 |
| `src/sidepanel/components/FileChip.test.tsx` (新) | 上者组件测试 | 4 |
| `src/sidepanel/components/Chat.tsx` (改) | `ToolsMenu` 改"附加文件"、`<input accept>`、分流、FileChip 行、paste/drop、request_local_file 卡片 | 4 |
| `src/types/messages.ts` (改) | SW↔panel `request-local-file` / `local-file-response` 协议 | 4 |
| `src/background/index.ts` (改) | request_local_file 往返 + needs-file-access 泛化 | 2,4 |

---

# Phase 1 — 写出 MVP(`save_to_downloads`)

独立可发布:agent 能把文本内容写到 `Downloads/pie/`。

### Task 1.1: `sanitizeDownloadName` 纯函数

**Files:**
- Create: `src/lib/files/download-name.ts`
- Test: `src/lib/files/download-name.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/files/download-name.test.ts
import { describe, it, expect } from "vitest";
import { sanitizeDownloadName } from "./download-name";

describe("sanitizeDownloadName", () => {
  it("prefixes pie/ for a plain name", () => {
    expect(sanitizeDownloadName("report.md")).toBe("pie/report.md");
  });
  it("keeps an existing pie/ prefix without doubling", () => {
    expect(sanitizeDownloadName("pie/report.md")).toBe("pie/report.md");
  });
  it("strips leading slashes (no absolute paths)", () => {
    expect(sanitizeDownloadName("/etc/passwd")).toBe("pie/etc/passwd");
  });
  it("strips .. traversal segments", () => {
    expect(sanitizeDownloadName("../../secret.txt")).toBe("pie/secret.txt");
    expect(sanitizeDownloadName("pie/../../x")).toBe("pie/x");
  });
  it("collapses backslashes and empty segments", () => {
    expect(sanitizeDownloadName("a//b\\c")).toBe("pie/a/b/c");
  });
  it("falls back to a default when name is empty after cleaning", () => {
    expect(sanitizeDownloadName("../..")).toBe("pie/untitled.txt");
    expect(sanitizeDownloadName("")).toBe("pie/untitled.txt");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/files/download-name.test.ts`
Expected: FAIL（`sanitizeDownloadName` 未定义 / 模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/lib/files/download-name.ts
/**
 * Normalize an agent-supplied download name into a safe relative path under
 * `pie/`. Strips absolute-path leading slashes and `..` traversal so a
 * download can never escape the Downloads root.
 */
export function sanitizeDownloadName(raw: string): string {
  const segments = (raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  // Drop a leading "pie" so we don't double-prefix.
  if (segments[0] === "pie") segments.shift();
  const rel = segments.join("/");
  return rel.length > 0 ? `pie/${rel}` : "pie/untitled.txt";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/files/download-name.test.ts`
Expected: PASS（6 passed）

- [ ] **Step 5: 提交**

```bash
git add src/lib/files/download-name.ts src/lib/files/download-name.test.ts
git commit -m "feat(files): sanitizeDownloadName for save_to_downloads"
```

### Task 1.2: chrome mock 补 `downloads`

**Files:**
- Modify: `src/test/setup.ts`

- [ ] **Step 1: 在 chromeMock 加 downloads(行 ~250 导出前)**

在 `src/test/setup.ts` 里,`chromeMock`/`runtime` 同级新增一个 `downloads` 对象并挂到导出的 mock 上。找到组装 `chromeMock` 的对象字面量,加入:

```ts
const downloads = {
  // resolves to a fake downloadId; tests spy on this to assert args.
  download: vi.fn(async (_opts: chrome.downloads.DownloadOptions) => 1),
};
```
并在最终导出的 chrome mock 对象里加上 `downloads,`(与 `runtime,` 并列)。

- [ ] **Step 2: 在 reset 区(行 ~276 `runtime.connect.mockClear()` 附近)清理**

```ts
downloads.download.mockClear();
```

- [ ] **Step 3: 验证不破坏现有测试**

Run: `pnpm vitest run src/lib/agent/tools/search.test.ts`
Expected: PASS（确认 setup.ts 仍可加载）

- [ ] **Step 4: 提交**

```bash
git add src/test/setup.ts
git commit -m "test: add chrome.downloads mock"
```

### Task 1.3: `saveToDownloadsTool`

**Files:**
- Create: `src/lib/agent/tools/files.ts`
- Test: `src/lib/agent/tools/files.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/agent/tools/files.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { saveToDownloadsTool } from "./files";

const ctx = { tabId: 1 } as Parameters<typeof saveToDownloadsTool.handler>[1];

describe("save_to_downloads tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes content under pie/ via chrome.downloads with a data: URL", async () => {
    const r = await saveToDownloadsTool.handler(
      { filename: "notes/summary.md", content: "# Hello\nworld" },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.filename).toBe("pie/notes/summary.md");
    expect(opts.conflictAction).toBe("uniquify");
    expect(opts.saveAs).toBe(false);
    expect(opts.url).toMatch(/^data:text\/plain;charset=utf-8,/);
    expect(decodeURIComponent(opts.url.split(",")[1])).toBe("# Hello\nworld");
    expect(r.observation).toContain("pie/notes/summary.md");
  });

  it("passes saveAs:true through", async () => {
    await saveToDownloadsTool.handler(
      { filename: "x.txt", content: "hi", saveAs: true },
      ctx,
    );
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.saveAs).toBe(true);
  });

  it("uses provided mime in the data URL", async () => {
    await saveToDownloadsTool.handler(
      { filename: "a.json", content: "{}", mime: "application/json" },
      ctx,
    );
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.url).toMatch(/^data:application\/json;charset=utf-8,/);
  });

  it("fails when content is missing", async () => {
    const r = await saveToDownloadsTool.handler({ filename: "a.txt" }, ctx);
    expect(r.success).toBe(false);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/agent/tools/files.test.ts`
Expected: FAIL（`saveToDownloadsTool` 不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/lib/agent/tools/files.ts
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { sanitizeDownloadName } from "@/lib/files/download-name";

interface SaveArgs {
  filename?: string;
  content?: string;
  mime?: string;
  saveAs?: boolean;
}

export const saveToDownloadsTool: Tool = {
  name: "save_to_downloads",
  description:
    "Write text content to the user's local Downloads folder under a 'pie/' subfolder. " +
    "Use for saving generated reports, code, or markdown. Set save_as=true to let the user " +
    "pick the location via a Save As dialog. Cannot write to arbitrary absolute paths.",
  parameters: {
    type: "object",
    properties: {
      filename: { type: "string", description: 'Relative file name, e.g. "report.md" or "notes/summary.md". Always saved under pie/.' },
      content: { type: "string", description: "The text content to write." },
      mime: { type: "string", description: 'MIME type. Default "text/plain".' },
      save_as: { type: "boolean", description: "If true, prompt the user with a Save As dialog. Default false." },
    },
    required: ["filename", "content"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as SaveArgs & { save_as?: boolean };
    if (typeof a.content !== "string") {
      return { success: false, error: "content is required (string)" };
    }
    const filename = sanitizeDownloadName(typeof a.filename === "string" ? a.filename : "");
    const mime = typeof a.mime === "string" && a.mime ? a.mime : "text/plain";
    const saveAs = a.save_as === true || a.saveAs === true;
    const url = `data:${mime};charset=utf-8,${encodeURIComponent(a.content)}`;
    try {
      await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs });
    } catch (e) {
      return { success: false, error: `download_failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return {
      success: true,
      observation: `Saved to Downloads/${filename}${saveAs ? " (user chose location via Save As)" : ""}. Note: if a same-named file existed, Chrome appended a numeric suffix.`,
    };
  },
};

export const LOCAL_FILE_TOOLS: Tool[] = [saveToDownloadsTool];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/tools/files.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/tools/files.ts src/lib/agent/tools/files.test.ts
git commit -m "feat(files): save_to_downloads tool"
```

### Task 1.4: 注册 tool + class + manifest 权限

**Files:**
- Modify: `src/lib/agent/tools.ts`
- Modify: `src/lib/agent/tool-names.ts`
- Modify: `manifest.json`

- [ ] **Step 1: tools.ts import + 并入 BUILT_IN_TOOLS**

在 `src/lib/agent/tools.ts` 顶部 import 区(`import { PDF_TOOLS } from "./tools/pdf";` 旁)加:
```ts
import { LOCAL_FILE_TOOLS } from "./tools/files";
```
在 `BUILT_IN_TOOLS` 数组尾部(`...PDF_TOOLS,` 之后)加:
```ts
  ...LOCAL_FILE_TOOLS,
```

- [ ] **Step 2: tool-names.ts 加名字 + 分类**

紧接 `PDF_TOOL_NAMES` 定义之后新增:
```ts
// Local file I/O tools.
//   save_to_downloads — write (creates a file in the user's Downloads).
//   read_local_file / request_local_file — read (added in later phases).
export const LOCAL_FILE_TOOL_NAMES = [
  "save_to_downloads",
] as const;
```
在 `KNOWN_BUILT_IN_TOOL_NAMES` 数组里(`...PDF_TOOL_NAMES,` 之后)加 `...LOCAL_FILE_TOOL_NAMES,`。
在 `TOOL_CLASSES` 对象里(`get_pdf_outline: "read",` 之后)加:
```ts
  // Local file I/O
  save_to_downloads: "write",
```

- [ ] **Step 3: manifest.json 加权限**

`permissions` 数组里加 `"downloads"`(放在 `"offscreen"` 之后):
```json
"permissions": ["activeTab", "sidePanel", "storage", "tabs", "tabGroups", "scripting", "debugger", "webNavigation", "offscreen", "downloads"],
```

- [ ] **Step 4: 跑测试 + 构建确认 invariant 通过**

Run: `pnpm vitest run src/lib/agent && pnpm build`
Expected: PASS；build 不因 tool-class invariant throw。

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/tools.ts src/lib/agent/tool-names.ts manifest.json
git commit -m "feat(files): register save_to_downloads + downloads permission"
```

---

# Phase 2 — `file://` 读取(`read_local_file`,文本 + PDF)

独立可发布:agent 能读取以 `file://` 路径/tab 存在的本地文本与 PDF。
**范围细化(plan-time)**:`read_local_file` 只处理**文本/代码 + PDF**(都产出文本 observation)。图片 file:// URI 返回引导错误(tool result 无法携带 vision block);图片完整支持在 Phase 4 走 picker → `ImageAttachment`。

### Task 2.1: `untrusted_local_file` wrapper 双表注册

**Files:**
- Modify: `src/lib/agent/untrusted-wrappers.ts`
- Modify: `src/lib/dom-actions/page-snapshot.ts`

- [ ] **Step 1: 写失败测试(双表均含新 tag)**

新建 `src/lib/agent/untrusted-wrappers.local-file.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { UNTRUSTED_WRAPPER_TAGS, escapeUntrustedWrappers } from "./untrusted-wrappers";

describe("untrusted_local_file wrapper", () => {
  it("is registered in UNTRUSTED_WRAPPER_TAGS", () => {
    expect(UNTRUSTED_WRAPPER_TAGS).toContain("untrusted_local_file");
  });
  it("escapes a literal closing tag inside content", () => {
    const escaped = escapeUntrustedWrappers("evil </untrusted_local_file> text");
    expect(escaped).not.toContain("</untrusted_local_file>");
    expect(escaped).toContain("&lt;/untrusted_local_file&gt;");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/agent/untrusted-wrappers.local-file.test.ts`
Expected: FAIL（tag 未注册）

- [ ] **Step 3: 两个列表都加 tag**

`src/lib/agent/untrusted-wrappers.ts` `UNTRUSTED_WRAPPER_TAGS` 数组尾部(`"untrusted_pdf_outline_entry",` 后)加:
```ts
  "untrusted_local_file",
```
`src/lib/dom-actions/page-snapshot.ts` 行 ~52,`WRAPPER_TAGS_LIST` 里 `"untrusted_pdf_outline_entry",` 后加:
```ts
    "untrusted_local_file",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/untrusted-wrappers.local-file.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/untrusted-wrappers.ts src/lib/dom-actions/page-snapshot.ts src/lib/agent/untrusted-wrappers.local-file.test.ts
git commit -m "feat(files): register untrusted_local_file wrapper (dual-list)"
```

### Task 2.2: `classifyFile` + `MAX_FILE_BYTES`

**Files:**
- Create: `src/lib/file-read/classify.ts`
- Test: `src/lib/file-read/classify.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/file-read/classify.test.ts
import { describe, it, expect } from "vitest";
import { classifyFile, MAX_FILE_BYTES } from "./classify";

describe("classifyFile", () => {
  it("classifies images by mime", () => {
    expect(classifyFile("a.png", "image/png")).toBe("image");
  });
  it("classifies pdf by mime or extension", () => {
    expect(classifyFile("doc.pdf", "application/pdf")).toBe("pdf");
    expect(classifyFile("doc.pdf", "")).toBe("pdf");
  });
  it("classifies text by mime", () => {
    expect(classifyFile("a.txt", "text/plain")).toBe("text");
  });
  it("classifies common code/text extensions when mime is empty", () => {
    for (const n of ["a.md", "a.ts", "a.json", "a.csv", "a.py", "a.log"]) {
      expect(classifyFile(n, "")).toBe("text");
    }
  });
  it("returns unsupported for unknown binary", () => {
    expect(classifyFile("a.bin", "application/octet-stream")).toBe("unsupported");
    expect(classifyFile("a.docx", "")).toBe("unsupported");
  });
  it("exposes a 5MB cap", () => {
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run src/lib/file-read/classify.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/lib/file-read/classify.ts
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB hard cap

export type FileKind = "text" | "pdf" | "image" | "unsupported";

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "yaml", "yml",
  "html", "htm", "css", "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "c", "h", "cpp", "hpp", "sh", "toml", "ini", "env", "sql",
]);

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Decide how a picked/fetched file should be read. mime may be "" (file:// fetch often omits it). */
export function classifyFile(name: string, mime: string): FileKind {
  const e = ext(name);
  if (IMAGE_MIMES.has(mime) || ["jpg", "jpeg", "png", "webp", "gif"].includes(e)) return "image";
  if (mime === "application/pdf" || e === "pdf") return "pdf";
  if (mime.startsWith("text/") || TEXT_EXTS.has(e)) return "text";
  return "unsupported";
}
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm vitest run src/lib/file-read/classify.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/file-read/classify.ts src/lib/file-read/classify.test.ts
git commit -m "feat(files): classifyFile + 5MB cap"
```

### Task 2.3: `readLocalFileTool`(text + pdf)

**Files:**
- Modify: `src/lib/agent/tools/files.ts`
- Modify: `src/lib/agent/tools/files.test.ts`

- [ ] **Step 1: 追加失败测试**

向 `files.test.ts` 追加(顶部补 import):
```ts
import { readLocalFileTool } from "./files";
import { sendToOffscreen } from "@/background/offscreen-manager";
vi.mock("@/background/offscreen-manager", () => ({ sendToOffscreen: vi.fn() }));

describe("read_local_file tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (chrome.extension as { isAllowedFileSchemeAccess: ReturnType<typeof vi.fn> })
      .isAllowedFileSchemeAccess = vi.fn(async () => true);
    globalThis.fetch = vi.fn();
  });

  it("reads a text file and wraps it untrusted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: { get: () => "text/plain" },
      text: async () => "hello world",
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(true);
    expect(r.observation).toMatch(/<untrusted_local_file[^>]*name="a.txt"/);
    expect(r.observation).toContain("hello world");
  });

  it("normalizes a bare absolute path to file://", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "text/plain" }, text: async () => "x",
    });
    await readLocalFileTool.handler({ uri: "/tmp/a.txt" }, { tabId: 1 } as never);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("file:///tmp/a.txt");
  });

  it("returns file_access_denied when toggle is off", async () => {
    (chrome.extension as { isAllowedFileSchemeAccess: ReturnType<typeof vi.fn> })
      .isAllowedFileSchemeAccess = vi.fn(async () => false);
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("file_access_denied");
  });

  it("parses a PDF via offscreen", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "application/pdf" }, arrayBuffer: async () => new ArrayBuffer(8),
    });
    (sendToOffscreen as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ total_pages: 1 }) // pdf:parse_bytes returns outline-ish
      .mockResolvedValueOnce({ pages: [{ page: 1, text: "pdf text" }], total_pages: 1 });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.pdf" }, { tabId: 1 } as never);
    expect(r.success).toBe(true);
    expect(r.observation).toContain("pdf text");
  });

  it("rejects image uris with guidance", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => new ArrayBuffer(8),
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.png" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("image_via_picker");
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run src/lib/agent/tools/files.test.ts`
Expected: FAIL（`readLocalFileTool` 不存在）

- [ ] **Step 3: 实现 readLocalFileTool**

> PDF 分支调用 `sendToOffscreen({ type: "pdf:parse_bytes", ... })`,该消息在 Phase 3 实装;Phase 2 阶段 offscreen 端尚未支持会 reject,测试用 mock 覆盖。生产联调在 Phase 3 后完成。

向 `src/lib/agent/tools/files.ts` 追加(顶部补 import):
```ts
import { sendToOffscreen } from "@/background/offscreen-manager";
import { classifyFile, MAX_FILE_BYTES } from "@/lib/file-read/classify";
import { escapeUntrustedWrappers, escapeWrapperAttribute } from "../untrusted-wrappers";

const READ_MAX_CHARS = 200_000; // injected-text safety ceiling (≪ 5MB)

function normalizeFileUri(uri: string): string {
  const u = uri.trim();
  if (u.startsWith("file://")) return u;
  if (u.startsWith("/")) return `file://${u}`;
  return u; // leave http(s)/blob to fetch; handler validates below
}

function basename(uri: string): string {
  const noQuery = uri.split(/[?#]/)[0];
  const parts = noQuery.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "file";
}

interface ReadLocalArgs { uri?: string }

export const readLocalFileTool: Tool = {
  name: "read_local_file",
  description:
    "Read a local file by its file:// URI (or absolute path) and return its text. Works for " +
    "text/code files and PDFs. The user must have enabled 'Allow access to file URLs' for the " +
    "extension. For images, ask the user to attach them via the + menu instead.",
  parameters: {
    type: "object",
    properties: {
      uri: { type: "string", description: 'A file:// URI or absolute path, e.g. "file:///Users/me/notes.md".' },
    },
    required: ["uri"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ReadLocalArgs;
    if (typeof a.uri !== "string" || !a.uri.trim()) {
      return { success: false, error: "uri is required" };
    }
    const uri = normalizeFileUri(a.uri);
    if (uri.startsWith("file://")) {
      const allowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (!allowed) {
        return { success: false, error: "file_access_denied: enable 'Allow access to file URLs' in chrome://extensions to read local files" };
      }
    }
    let res: Response;
    try {
      res = await fetch(uri);
    } catch (e) {
      return { success: false, error: `fetch_failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) return { success: false, error: `fetch_failed: status ${res.status}` };

    const name = basename(uri);
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const kind = classifyFile(name, mime);

    if (kind === "image") {
      return { success: false, error: "image_via_picker: cannot return images through read_local_file; ask the user to attach the image via the + menu." };
    }
    if (kind === "unsupported") {
      return { success: false, error: `unsupported_type: ${name} (${mime || "unknown"})` };
    }

    if (kind === "text") {
      const text = await res.text();
      const truncated = text.length > READ_MAX_CHARS;
      const body = truncated ? `${text.slice(0, READ_MAX_CHARS)}\n…[truncated]` : text;
      return {
        success: true,
        observation:
          `<untrusted_local_file name="${escapeWrapperAttribute(name)}" mime="${escapeWrapperAttribute(mime || "text/plain")}" truncated="${truncated}">\n` +
          `${escapeUntrustedWrappers(body)}\n</untrusted_local_file>`,
      };
    }

    // kind === "pdf"
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return { success: false, error: `too_large: exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB cap` };
    }
    try {
      const parsed = (await sendToOffscreen({
        type: "pdf:parse_bytes", bytes, cacheKey: uri,
      })) as { pages: Array<{ page: number; text: string }>; total_pages: number };
      const joined = parsed.pages.map((p) => p.text).join("\n").slice(0, READ_MAX_CHARS);
      return {
        success: true,
        observation:
          `<untrusted_local_file name="${escapeWrapperAttribute(name)}" mime="application/pdf" total_pages="${parsed.total_pages}">\n` +
          `${escapeUntrustedWrappers(joined)}\n</untrusted_local_file>`,
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
```
并把 `readLocalFileTool` 加入文件底部 `LOCAL_FILE_TOOLS`:
```ts
export const LOCAL_FILE_TOOLS: Tool[] = [saveToDownloadsTool, readLocalFileTool];
```

> 注:上面测试 mock 了 `pdf:parse_bytes` 直接返回 `{ pages, total_pages }`。实现里对 PDF 只发**一次** `pdf:parse_bytes`(不像 read_pdf 先 outline 再 read_page),因 cacheKey=uri 且我们要整篇文本。调整 Task 2.3 的 PDF 测试为单次 mock:
```ts
    (sendToOffscreen as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ pages: [{ page: 1, text: "pdf text" }], total_pages: 1 });
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm vitest run src/lib/agent/tools/files.test.ts`
Expected: PASS

- [ ] **Step 5: chrome mock 补 `extension.isAllowedFileSchemeAccess`**

`src/test/setup.ts`:若 `chrome.extension` mock 不存在或缺该方法,加:
```ts
const extension = {
  isAllowedFileSchemeAccess: vi.fn(async () => true),
};
```
并把 `extension,` 加入导出的 chrome mock 对象;reset 区加 `extension.isAllowedFileSchemeAccess.mockClear();`。

- [ ] **Step 6: 注册 read_local_file 名字 + class**

`tool-names.ts`:`LOCAL_FILE_TOOL_NAMES` 加 `"read_local_file",`;`TOOL_CLASSES` 加 `read_local_file: "read",`。

- [ ] **Step 7: 跑全量 + build**

Run: `pnpm vitest run src/lib/agent && pnpm build`
Expected: PASS（class invariant 通过）

- [ ] **Step 8: 提交**

```bash
git add src/lib/agent/tools/files.ts src/lib/agent/tools/files.test.ts src/lib/agent/tool-names.ts src/test/setup.ts
git commit -m "feat(files): read_local_file tool (text + pdf via file://)"
```

---

# Phase 3 — offscreen 按字节解析(`pdf:parse_bytes`)

让 Finder 选来的 PDF(无 fetch-able URL)也能解析。为 Phase 4 铺路;Phase 2 的 PDF 分支生产联调也在此后打通。

### Task 3.1: offscreen-manager 协议加 `pdf:parse_bytes`

**Files:**
- Modify: `src/background/offscreen-manager.ts`

- [ ] **Step 1: 扩展 `OffscreenRequest` 联合类型**

在 `OffscreenRequest` 联合里追加:
```ts
  | { type: "pdf:parse_bytes"; bytes: ArrayBuffer; cacheKey: string }
```

- [ ] **Step 2: 构建确认类型通过**

Run: `pnpm build`
Expected: PASS（仅类型扩展,无运行期改动）

- [ ] **Step 3: 提交**

```bash
git add src/background/offscreen-manager.ts
git commit -m "feat(offscreen): add pdf:parse_bytes request type"
```

### Task 3.2: offscreen pdf-parser 处理 `pdf:parse_bytes`

**Files:**
- Modify: `src/offscreen/pdf-parser.ts`
- Modify: `src/offscreen/pdf-parser.test.ts`

- [ ] **Step 1: 写失败测试**

向 `src/offscreen/pdf-parser.test.ts` 追加(对齐现有 `handleMessage` 测试风格,用 `deps.parseBytes` mock):
```ts
it("pdf:parse_bytes parses raw bytes and returns all pages", async () => {
  const state = { cache: new Map() };
  const deps = {
    parseBytes: vi.fn(async () => ({
      title: "t", totalPages: 2, outline: [],
      pages: [{ page: 1, text: "p1" }, { page: 2, text: "p2" }],
    })),
    fetchImpl: vi.fn(), // must NOT be called for bytes path
  };
  const bytes = new ArrayBuffer(16);
  const r = await handleMessage(
    { type: "pdf:parse_bytes", bytes, cacheKey: "k1" } as never,
    state as never,
    deps as never,
  );
  expect(r.ok).toBe(true);
  expect(deps.fetchImpl).not.toHaveBeenCalled();
  expect((r as { result: { total_pages: number } }).result.total_pages).toBe(2);
  // second call with same cacheKey hits cache (parseBytes called once)
  await handleMessage({ type: "pdf:parse_bytes", bytes, cacheKey: "k1" } as never, state as never, deps as never);
  expect(deps.parseBytes).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run src/offscreen/pdf-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/offscreen/pdf-parser.ts`:`OffscreenMessage` 联合(行 36-38)追加 `| { type: "pdf:parse_bytes"; bytes: ArrayBuffer; cacheKey: string }`。新增按字节取缓存的 helper:
```ts
async function getParsedFromBytes(
  bytes: ArrayBuffer, cacheKey: string, state: ParserState, deps: ParserDeps,
): Promise<ParsedPdf> {
  const cached = state.cache.get(cacheKey);
  if (cached) return cached;
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`too_large: ${Math.round(bytes.byteLength / (1024 * 1024))}MB exceeds ${MAX_BYTES / (1024 * 1024)}MB cap`);
  }
  let parsed: ParsedPdf;
  try {
    parsed = await deps.parseBytes(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "parse error";
    if (/password|encrypt/i.test(msg)) throw new Error(`encrypted_pdf: ${msg}`);
    throw new Error(`parse_failed: ${msg}`);
  }
  if (parsed.pages.every((p) => p.text.trim() === "")) throw new Error(SCAN_SENTINEL);
  state.cache.set(cacheKey, parsed);
  return parsed;
}
```
在 `handleMessage` 里:现有逻辑顶部 `const parsed = await getParsed(msg.url, ...)` 假设所有消息都有 `url`。改为在 switch 前分流 —— 把 `pdf:parse_bytes` 单独处理,返回所有页:
```ts
export async function handleMessage(msg, state, deps) {
  try {
    if (msg.type === "pdf:parse_bytes") {
      const parsed = await getParsedFromBytes(msg.bytes, msg.cacheKey, state, deps);
      return { ok: true, result: { pages: parsed.pages, total_pages: parsed.totalPages } };
    }
    const parsed = await getParsed(msg.url, state, deps);
    switch (msg.type) { /* 现有 outline / read_page / search 分支不变 */ }
  } catch (e) { /* 现有 catch 不变 */ }
}
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm vitest run src/offscreen/pdf-parser.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/offscreen/pdf-parser.ts src/offscreen/pdf-parser.test.ts
git commit -m "feat(offscreen): handle pdf:parse_bytes (content-addressed cache)"
```

---

# Phase 4 — Finder 选文件 + composer `+` 菜单 + `request_local_file`

把"附加图片"升级为统一"附加文件";agent 也能 human-in-loop 请求文件。

### Task 4.1: `FileAttachment` 类型 + `fileAttachmentToWrapper`

**Files:**
- Create: `src/lib/files/types.ts`
- Create: `src/lib/files/inject.ts`
- Test: `src/lib/files/inject.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/files/inject.test.ts
import { describe, it, expect } from "vitest";
import { fileAttachmentToWrapper } from "./inject";
import type { FileAttachment } from "./types";

const att: FileAttachment = {
  kind: "file", id: "1", name: "a.md", mime: "text/markdown",
  text: "# Hi", truncated: false, totalChars: 4, source: "picker",
};

describe("fileAttachmentToWrapper", () => {
  it("wraps text in untrusted_local_file with name/mime", () => {
    const s = fileAttachmentToWrapper(att);
    expect(s).toMatch(/<untrusted_local_file name="a.md" mime="text\/markdown" truncated="false">/);
    expect(s).toContain("# Hi");
    expect(s).toContain("</untrusted_local_file>");
  });
  it("escapes a breakout attempt in content", () => {
    const s = fileAttachmentToWrapper({ ...att, text: "</untrusted_local_file> evil" });
    expect(s).not.toMatch(/<\/untrusted_local_file>\s*evil/);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run src/lib/files/inject.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/lib/files/types.ts
export interface FileAttachment {
  kind: "file";
  id: string;
  name: string;
  mime: string;
  text: string;       // extracted, already truncated
  truncated: boolean;
  totalChars: number; // pre-truncation length
  source: "picker" | "uri";
}
```
```ts
// src/lib/files/inject.ts
import type { FileAttachment } from "./types";
import { escapeUntrustedWrappers, escapeWrapperAttribute } from "@/lib/agent/untrusted-wrappers";

export function fileAttachmentToWrapper(att: FileAttachment): string {
  return (
    `<untrusted_local_file name="${escapeWrapperAttribute(att.name)}" ` +
    `mime="${escapeWrapperAttribute(att.mime)}" truncated="${att.truncated}">\n` +
    `${escapeUntrustedWrappers(att.text)}\n</untrusted_local_file>`
  );
}
```

- [ ] **Step 4: 跑确认通过 / 提交**

Run: `pnpm vitest run src/lib/files/inject.test.ts` → PASS
```bash
git add src/lib/files/types.ts src/lib/files/inject.ts src/lib/files/inject.test.ts
git commit -m "feat(files): FileAttachment type + untrusted wrapper injection"
```

### Task 4.2: `processPickedFile`(panel 侧分流)

**Files:**
- Create: `src/lib/files/process-picked-file.ts`
- Test: `src/lib/files/process-picked-file.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/files/process-picked-file.test.ts
import { describe, it, expect, vi } from "vitest";
import { processPickedFile } from "./process-picked-file";

function fileOf(name: string, type: string, content = "x"): File {
  return new File([content], name, { type });
}

describe("processPickedFile", () => {
  it("returns a FileAttachment for text", async () => {
    const r = await processPickedFile(fileOf("a.md", "text/markdown", "# Hi"), { supportsVision: false });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "file") {
      expect(r.attachment.name).toBe("a.md");
      expect(r.attachment.text).toContain("# Hi");
    } else throw new Error("expected file");
  });

  it("rejects images when vision unsupported", async () => {
    const r = await processPickedFile(fileOf("a.png", "image/png"), { supportsVision: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_vision");
  });

  it("rejects files over the 5MB cap", async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.txt", { type: "text/plain" });
    const r = await processPickedFile(big, { supportsVision: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
  });

  it("rejects unsupported types", async () => {
    const r = await processPickedFile(fileOf("a.bin", "application/octet-stream"), { supportsVision: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported");
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run src/lib/files/process-picked-file.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

> 图片复用现有 `resizePanel`(`src/lib/images/resize-panel.ts`)。它的签名是 `resizePanel(file: File): Promise<ResizePanelOutcome>`,outcome = `{ ok: true; value: { mediaType; data; width; height; byteLength } } | { ok: false; reason }`(见 Chat.tsx `addFiles` 行 ~580 的用法)。我们调它,从 `r.value` 构造 `ImageAttachment`(与 Chat.tsx 同构)。

```ts
// src/lib/files/process-picked-file.ts
import type { ImageAttachment } from "@/lib/images";
import { resizePanel } from "@/lib/images/resize-panel";
import type { FileAttachment } from "./types";
import { classifyFile, MAX_FILE_BYTES } from "@/lib/file-read/classify";
import { sendToOffscreen } from "@/background/offscreen-manager";

const READ_MAX_CHARS = 200_000;

export type ProcessResult =
  | { ok: true; kind: "image"; attachment: ImageAttachment }
  | { ok: true; kind: "file"; attachment: FileAttachment }
  | { ok: false; reason: "too_large" | "no_vision" | "unsupported" | "error"; message: string };

let counter = 0;
function newId(): string { return `f${Date.now()}_${counter++}`; }

export async function processPickedFile(
  file: File, opts: { supportsVision: boolean },
): Promise<ProcessResult> {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: "too_large", message: `${file.name} exceeds 5MB` };
  }
  const kind = classifyFile(file.name, file.type);
  if (kind === "unsupported") {
    return { ok: false, reason: "unsupported", message: `${file.name}: unsupported type` };
  }
  if (kind === "image") {
    if (!opts.supportsVision) return { ok: false, reason: "no_vision", message: "current model has no vision" };
    const r = await resizePanel(file);
    if (!r.ok) return { ok: false, reason: "error", message: `image rejected: ${r.reason}` };
    const att: ImageAttachment = {
      kind: "image", id: newId(),
      mediaType: r.value.mediaType, data: r.value.data,
      width: r.value.width, height: r.value.height, byteLength: r.value.byteLength,
    };
    return { ok: true, kind: "image", attachment: att };
  }
  if (kind === "text") {
    const raw = await file.text();
    const truncated = raw.length > READ_MAX_CHARS;
    return {
      ok: true, kind: "file",
      attachment: {
        kind: "file", id: newId(), name: file.name, mime: file.type || "text/plain",
        text: truncated ? `${raw.slice(0, READ_MAX_CHARS)}\n…[truncated]` : raw,
        truncated, totalChars: raw.length, source: "picker",
      },
    };
  }
  // pdf
  try {
    const bytes = await file.arrayBuffer();
    const parsed = (await sendToOffscreen({
      type: "pdf:parse_bytes", bytes, cacheKey: `${file.name}:${file.size}`,
    })) as { pages: Array<{ page: number; text: string }>; total_pages: number };
    const joined = parsed.pages.map((p) => p.text).join("\n");
    const truncated = joined.length > READ_MAX_CHARS;
    return {
      ok: true, kind: "file",
      attachment: {
        kind: "file", id: newId(), name: file.name, mime: "application/pdf",
        text: truncated ? `${joined.slice(0, READ_MAX_CHARS)}\n…[truncated]` : joined,
        truncated, totalChars: joined.length, source: "picker",
      },
    };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm vitest run src/lib/files/process-picked-file.test.ts`
Expected: PASS（image 测试可 `vi.mock("@/lib/images/resize-panel")` 让 `resizePanel` 返回 `{ok:true,value:{...}}`;`@/background/offscreen-manager` 同样 mock）

- [ ] **Step 5: 提交**

```bash
git add src/lib/files/process-picked-file.ts src/lib/files/process-picked-file.test.ts
git commit -m "feat(files): processPickedFile dispatch (image/text/pdf)"
```

### Task 4.3: `FileChip` 组件

**Files:**
- Create: `src/sidepanel/components/FileChip.tsx`
- Test: `src/sidepanel/components/FileChip.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/FileChip.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileChip } from "./FileChip";
import type { FileAttachment } from "@/lib/files/types";

const att: FileAttachment = {
  kind: "file", id: "1", name: "report.md", mime: "text/markdown",
  text: "x", truncated: false, totalChars: 1, source: "picker",
};

describe("FileChip", () => {
  it("shows the file name and calls onRemove", () => {
    const onRemove = vi.fn();
    render(<FileChip attachment={att} onRemove={onRemove} />);
    expect(screen.getByText("report.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledWith("1");
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run src/sidepanel/components/FileChip.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**(对齐 `QuoteChip.tsx` 现有样式类)

```tsx
// src/sidepanel/components/FileChip.tsx
import type { FileAttachment } from "@/lib/files/types";
import { useT } from "@/lib/i18n";

export function FileChip({ attachment, onRemove }: { attachment: FileAttachment; onRemove: (id: string) => void }) {
  const t = useT();
  const icon = attachment.mime === "application/pdf" ? "📄" : "📝";
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-line bg-field px-2 py-1 text-[12px] text-fg-1">
      <span aria-hidden="true">{icon}</span>
      <span className="max-w-[160px] truncate">{attachment.name}</span>
      {attachment.truncated && <span className="text-fg-3">({t("chat.files.truncated")})</span>}
      <button
        type="button"
        aria-label={t("chat.files.remove")}
        onClick={() => onRemove(attachment.id)}
        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-line bg-canvas text-fg-2 hover:text-fg-1"
      >
        ×
      </button>
    </div>
  );
}
```
在 i18n 字典加新 key。两个文件 `src/lib/i18n/dictionaries/en.ts` 与 `src/lib/i18n/dictionaries/zh-CN.ts`,在 `chat:` 对象下(与 `attachment:` 平级,行 ~124 附近)新增 `files` 组:
```ts
// en.ts
files: { attachFile: "Attach file", truncated: "truncated", remove: "Remove file", fileAttachments: "File attachments" },
// zh-CN.ts
files: { attachFile: "附加文件", truncated: "已截断", remove: "移除文件", fileAttachments: "文件附件" },
```
（types.ts 若是从 en 字典推导类型则自动覆盖;若手维护,同步补 key。）

- [ ] **Step 4: 跑确认通过 / 提交**

Run: `pnpm vitest run src/sidepanel/components/FileChip.test.tsx` → PASS
```bash
git add src/sidepanel/components/FileChip.tsx src/sidepanel/components/FileChip.test.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "feat(ui): FileChip component"
```

### Task 4.4: composer `+` 菜单"附加图片"→"附加文件" + 分流 + FileChip 行

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`
- Modify: i18n 资源(menu label)

- [ ] **Step 1: 写/改测试**（`Chat.test.tsx` 加用例:菜单项文案为"附加文件",选 .md 后出现 FileChip）

参照现有 `Chat.test.tsx` 打开 ToolsMenu 的写法,新增:
```tsx
it("attach menu reads 'Attach file' and accepts non-image files", async () => {
  // render Chat with supportsVision=false
  // open ToolsMenu, assert the menu item label is the attach-file label (not image-only)
  // assert the hidden <input> accept includes .pdf / text types (not image-only)
});
```
（按 `Chat.test.tsx` 既有 render helper 与 query 习惯补全断言。）

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run src/sidepanel/components/Chat.test.tsx`
Expected: FAIL

- [ ] **Step 3: 改 Chat.tsx**

1. State:新增 `const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);`(import `FileAttachment`)。
2. 隐藏 input(行 ~1117):`accept` 从 `"image/jpeg,image/png,image/webp,image/gif"` 改为去掉 `accept`(或列全:images + `.txt,.md,.json,.csv,.pdf,.ts,.js,.py,...`),并 `multiple`。
3. 选文件回调:把现有 `addFiles`(image-only)替换为统一 `addPickedFiles`,对每个 File 调 `processPickedFile(file, { supportsVision })`,按 result.kind 分流:`image`→`setAttachments(prev=>[...prev,att])`;`file`→`setFileAttachments(prev=>[...prev,att])`;`!ok`→`showLocalToast(message)`。`onPasteFiles`/`onDropFiles` 同样改走 `addPickedFiles`。
4. `ToolsMenu`(行 ~1708):把 `attachDisabled = !supportsVision || attachmentCount >= MAX` 改掉 —— 文本/PDF 不需 vision,按钮不再整体 disabled;菜单项文案 `t("chat.attachment.attachImage")` → `t("chat.files.attachFile")`(Task 4.3 已加的 key)。vision/上限的提示改为选完后按类型在 toast 给出(image+no vision / image 超 `MAX_IMAGES_PER_TURN`)。
5. FileChip 行:在 quote chips 行(行 ~1158)与图片缩略图行(行 ~1170)之间,新增:
```tsx
{fileAttachments.length > 0 && (
  <div className="flex gap-2 px-4 pb-2 flex-wrap" aria-label={t("chat.files.fileAttachments")}>
    {fileAttachments.map((f) => (
      <FileChip key={f.id} attachment={f} onRemove={(id) => setFileAttachments((p) => p.filter((x) => x.id !== id))} />
    ))}
  </div>
)}
```
6. 发送时(`handleSubmit`,行 ~706 附近):把 `fileAttachments` 通过 `fileAttachmentToWrapper` 拼进 `expandedForLLM`(在 user content 之后追加各 wrapper),发送后 `setFileAttachments([])`。沿用现有 `expandedForLLM` 模式(slash 展开同位置)。

- [ ] **Step 4: 跑确认通过**

Run: `pnpm vitest run src/sidepanel/components/Chat.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/Chat.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "feat(ui): unify + menu into Attach file (image/text/pdf)"
```

### Task 4.5: `request_local_file`(SW↔panel human-in-loop)

**Files:**
- Modify: `src/types/messages.ts`
- Modify: `src/lib/agent/tools/files.ts`(+ test)
- Modify: `src/background/index.ts`
- Modify: `src/sidepanel/hooks/useSession/index.ts` 或 port-handlers(panel 侧响应)
- Modify: `src/sidepanel/components/Chat.tsx`(挂起卡片)
- Modify: `src/lib/agent/loop.ts`(注入 dep)

> 范式参照 CDP onboarding 往返:SW `port.postMessage({type:"request-local-file", requestId})` → panel 渲染卡片 → 用户点选 → panel `port.postMessage({type:"local-file-response", requestId, ...})` → SW 用 requestId 找到 pending resolver。`background/index.ts:1440` 的 `cdp-onboarding-response` 分支是现成模板。

- [ ] **Step 1: messages.ts 加协议类型**

```ts
// SW → panel
export type RequestLocalFileMessage = { type: "request-local-file"; sessionId: string; requestId: string };
// panel → SW
export type LocalFileResponseMessage =
  | { type: "local-file-response"; requestId: string; ok: true; name: string; mime: string; text: string; truncated: boolean }
  | { type: "local-file-response"; requestId: string; ok: false; reason: string };
```
并加入相应的 union（参照 cdp-onboarding 消息所在 union）。

- [ ] **Step 2: loop.ts 注入 dep + tool 工厂**

`buildRequestLocalFileTool(deps: { requestFile: () => Promise<LocalFileResult> })`:handler 调 `deps.requestFile()`,把结果包成 `<untrusted_local_file>` observation(复用 `fileAttachmentToWrapper` 或同构拼装);panel 不可用 / 超时 → 返回 `{ success:false, error:"panel_unavailable: ask the user to attach the file via the + menu, or provide a file:// path for read_local_file" }`。loop.ts 在组装 tools 处注入 `requestFile`,内部生成 requestId、`port.postMessage` 并在 pending map 注册 resolver(参照 cdp pending resolver),`local-file-response` 到达时 resolve;设 60s 超时 reject。

- [ ] **Step 3: 单测 tool 行为**

在 `files.test.ts` 加:`buildRequestLocalFileTool({ requestFile: async () => ({ok:true,name:"a.md",mime:"text/markdown",text:"hi",truncated:false}) })` → observation 含 `<untrusted_local_file name="a.md"` 与 `hi`;`requestFile` reject → `success:false` 且 error 含 `panel_unavailable`。

- [ ] **Step 4: background/index.ts 往返 wiring**

新增 pending resolver map(`Map<requestId, {resolve,reject}>`);`requestFile` dep 实现 = postMessage + 注册 resolver + 超时。`onMessage` 加 `local-file-response` 分支:取出 resolver、resolve/reject、删除 entry。(对照 `cdp-onboarding-response` 分支。)

- [ ] **Step 5: panel 侧响应 UI**

Chat.tsx:监听 `request-local-file`(经 port-handlers / useSession,参照 `cdpPending`/`answerCdp`),置 `pendingFileRequest` state → 渲染一张卡片(类 `CdpOnboardingCard`)"Pie 想读取一个文件" + [选择文件] 按钮;按钮 onClick 触发隐藏 `<input>`(用户手势)→ `processPickedFile` → `port.postMessage({type:"local-file-response", requestId, ...})` → 清卡片。用户取消 → 发 `{ok:false, reason:"cancelled"}`。

- [ ] **Step 6: 注册名字 + class + 并入工具列表**

`tool-names.ts`:`LOCAL_FILE_TOOL_NAMES` 加 `"request_local_file"`;`TOOL_CLASSES` 加 `request_local_file: "read"`。loop.ts 把工厂产物并进 `allTools`(行 1388,与 mouse/keyboard tools 同处注入)。

- [ ] **Step 7: 跑全量 + build**

Run: `pnpm test && pnpm build`
Expected: PASS（class invariant、所有单测、build invariants 通过）

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(files): request_local_file human-in-loop tool"
```

---

## 收尾

- [ ] **全量校验**:`pnpm test && pnpm build`,均 PASS。
- [ ] **release notes**:在 `docs/release-notes/` 加用户可见条目(English-first + 中文摘要,参照现有格式)。
- [ ] **手动验证清单**(load unpacked 后):
  - 让 agent "把这段写到本地 report.md" → `Downloads/pie/report.md` 出现。
  - 开一个本地 `file:///.../notes.md` tab,问 agent 内容 → agent 调 `read_local_file` 成功(需先开"允许访问文件 URL")。
  - `+` → 附加文件 → 选一个 .md / .pdf → 出现 FileChip → 发送 → agent 看到内容。
  - 选图片(vision 模型)→ 缩略图;无 vision 模型 → toast 提示。

---

## Self-Review 备忘(已核对)

- **Spec 覆盖**:写出(§4.3)→P1;file:// 读(§4.1)→P2;offscreen 字节(§5.2)→P3;Finder+UI+human-in-loop(§4.2)→P4;untrusted 双表(§6)→Task 2.1;read/write class(§6)→各 Task;5MB(§6)→Task 2.2/4.2;saveAs(§4.3)→Task 1.3。
- **范围细化**:read_local_file 图片走引导错误(tool result 无法带 vision block),图片完整能力归 picker/Phase 4 —— 与 spec 的"图片"目标一致,仅改变 file:// URI 下的图片入口。
- **类型一致**:`FileAttachment`、`ProcessResult`、`pdf:parse_bytes {bytes,cacheKey}`、`sanitizeDownloadName`、`classifyFile`/`MAX_FILE_BYTES` 在引用处签名一致。
- **已锁定的外部接口**:`resizePanel(file)→{ok,value:{mediaType,data,width,height,byteLength}}`、`useT` from `@/lib/i18n`、i18n 字典 `src/lib/i18n/dictionaries/{en,zh-CN}.ts` 的 `chat.files.*`。仅 `Chat.test.tsx` 的 render helper 需以仓库现状为准对齐(Task 4.4 Step 1)。
