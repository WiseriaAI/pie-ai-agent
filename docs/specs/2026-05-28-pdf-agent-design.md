# PDF Agent — Design

**Date**: 2026-05-28
**Status**: Draft (brainstorm output)
**Author**: brainstorm session with @wenkang

## 1. Motivation

用户在 Chrome 里看 PDF（论文、合同、本地文档）时，希望 Pie Agent 能像处理普通网页一样理解和回答 PDF 内容。Chrome 内置 PDF viewer 是个 sealed `chrome-extension://` frame，content script 注不进去，`read_page` 拿不到内容。需要新通路。

## 2. Goals / Non-goals

### Goals (MVP)

- 用户在 Chrome 默认 PDF viewer 看 PDF（远程 http(s) 或本地 file://）时，sidepanel Agent 能读取并回答 PDF 文本问题
- 支持本地 PDF，并优雅引导用户开 `Allow access to file URLs`
- 支持大 PDF（数百页）：tool-mediated 按需读取，不预塞全文
- 支持文档结构：outline / TOC、跨页 search、指定页读取
- 跟现有 tool / SW / sidepanel 架构正交，不改 read_page 语义

### Non-goals (不在 MVP)

- OCR / 扫描件 / 图像页（架构留 hook）
- PDF 渲染成图像给 vision 模型
- Form 字段提取 / annotations / 高亮 / 反向跳转
- 跨 PDF 检索（multi-doc RAG）
- 持久化缓存（IndexedDB）
- PDF 修改 / 导出
- bbox 信息暴露给 LLM（解析时已有，tool output 暂不带）
- 接管 Chrome PDF viewer / 自做 viewer 页面

## 3. Design choices (brainstorm 结论)

| 维度 | 选择 | 备选与理由 |
|------|------|----------|
| 入口 | Chrome 默认 viewer + sidepanel chat | 备选：接管 viewer / 拖拽上传。选 viewer + chat 因跟现有 tab-pinning 架构对齐，零接管 |
| Context shape | Tool-mediated (lazy) | 备选：预塞全文 / 预生成 outline+summary。选 lazy 因大 PDF 不爆 context，跟 `read_page` / `search` 模式一致 |
| Multimodal | 只读文本（MVP） | 备选：文本 + 页面图像 / OCR fallback。选只读文本以最快交付；扫描件返回结构化错误 |
| Tool surface | 独立 `pdf_*` tools | 备选：read_page polymorphic / 转发。选独立以保 tool description 精准、职责清 |
| 解析库 | LiteParse v2 WASM | 备选：pdf.js。选 LiteParse 因 PDFium 引擎提取质量高、JSON+bbox 输出结构化、Apache-2.0、4 MB |
| 运行时 | Offscreen document (单例) | 备选：sidepanel iframe / SW 直跑。选 offscreen 因生命周期独立于 sidepanel，且避开 WASM-in-SW edge cases |
| Cache | Session 内 in-memory，跨 session 重解析 | 备选：IndexedDB 持久化 / 不缓存。选 in-memory 因隐私友好（本地 PDF 不落盘）+ 逻辑简单 |
| file:// UX | 检测 + 引导卡片一键跳权限页 | 备选：拒绝本地 PDF / 拖拽上传。选引导卡保留本地场景且 UX 明确 |

## 4. Architecture

### 4.1 Components (5 new files + manifest)

1. **`src/offscreen/pdf-parser.html` + `pdf-parser.ts`**
   - Offscreen document 入口，持有 LiteParse WASM 实例
   - 内存 cache: `Map<cacheKey, ParsedPdf>`，cacheKey = `tab.url` (+ `Last-Modified` 头如果有)
   - 监听 SW message: `pdf:parse` / `pdf:read_page` / `pdf:search` / `pdf:outline`
2. **`src/lib/agent/tools/pdf.ts` + `pdf.test.ts`**
   - 注册 `read_pdf` / `search_pdf` / `get_pdf_outline`，全 read-class
   - Executor 通过 SW 转发到 offscreen，等响应回填 LLM
3. **`src/background/offscreen-manager.ts`**
   - 单例懒启 `chrome.offscreen.createDocument({ reasons: ['BLOBS'], justification: 'Parse PDF bytes with WASM-based parser' })`
   - 封装 SW ↔ offscreen 的 request/response message passing（带请求 ID 关联）
4. **`src/sidepanel/components/PdfPermissionCard.tsx`**
   - file:// 但权限未开时显示
   - 「读取本地 PDF 需要授权」+ 一键跳 `chrome://extensions/?id=<id>` + 图示说明 toggle 位置
   - 检测到权限开启后自动消失
5. **`src/lib/pdf/detect.ts` + `page-range.ts`**
   - `isPdfTab(tab)`: 大小写不敏感判断 `tab.url` 是否匹配 `\.pdf($|[?#])`。MVP 不引入 `webRequest`；少数无 `.pdf` 后缀的 PDF 走 LLM 主动调用 `read_pdf`，由 LiteParse 解析失败时返回 `not_a_pdf` 兜底
   - `parsePageRange(spec, total)`: 解析 `"1"`, `"1-3"`, `"1,3,5"`, `"1-3,7"`。规则：越界页号忽略不报错；空 spec → 首页；反向范围如 `"3-1"` 视为非法 → 返回空页集（不自动 swap，避免吞掉用户拼写错误）

### 4.2 Manifest 改动

```jsonc
{
  "permissions": [
    /* 已有 */
    "offscreen"       // 新增
  ],
  "host_permissions": ["<all_urls>"],   // 已有，覆盖远程 PDF
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"  // 加 wasm-unsafe-eval
  },
  "web_accessible_resources": [
    {
      "resources": ["liteparse.wasm", "offscreen/pdf-parser.html"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

本地 PDF 走用户手动开 `Allow access to file URLs`，**不在 manifest 申请**（Chrome 不允许）。

### 4.3 Dependency

- `pnpm add @llamaindex/liteparse-wasm` (v2.0.0, Apache-2.0, ~4 MB unpacked, file count 7)
- WASM 由 vite plugin 复制到 `dist/liteparse.wasm`；offscreen doc 通过 `chrome.runtime.getURL('liteparse.wasm')` + `WebAssembly.compileStreaming` 加载

## 5. Data flow

### 5.1 Lifecycle 时序

```
[首次问 PDF 问题]
  user                sidepanel        SW         offscreen      tab(file://*.pdf)
   │ "总结一下这篇"
   │ ───────────────► │
   │                  │ Agent loop
   │                  │ tool: read_pdf(page_range:"1-3")
   │                  │ ─────────────►
   │                  │              │ check cache miss
   │                  │              │ ensureOffscreen()
   │                  │              │ send {type:'pdf:read_page', url, range}
   │                  │              │ ─────────────►
   │                  │              │              │ cache miss → fetch(url)
   │                  │              │              │ ──────────────────────────►
   │                  │              │              │ ◄─ Uint8Array ──────────────
   │                  │              │              │ LiteParse.parse(bytes)
   │                  │              │              │ cache.set(url, parsed)
   │                  │              │ ◄─ {pages[0..2].text, totalPages}
   │                  │ ◄─ tool result
   │ ◄── next turn → LLM → response

[再问后续问题，同一 PDF]
   │ "第 5 页讲了啥"   │ tool: read_pdf(page_range:"5")
   │                  │ ─────────────► │ ── cache hit ──► │ {pages[4].text}
   │                  │                │ ◄────────────── │
```

### 5.2 Cache key

MVP 简化为 `tab.url`。SW 退休 / sidepanel 重启 / 关闭 PDF tab 都会自然清掉 cache，不需要 content-hash 兜底。如果将来用户报"PDF 改了但 Agent 没刷新"，再升级为 content hash（bytes 流过来现成可算）。

### 5.3 Offscreen lifecycle

- Lazy 启动：第一次需要 PDF tool 时调用 `chrome.offscreen.createDocument`
- 不主动关闭：让 Chrome 跟 SW 一起回收
- SW 重启 → offscreen 一起回收 → 下次 lazy 重启 → 重新解析（符合 "session 内 cache" 语义）

## 6. Tool surface

### 6.1 `read_pdf`

```ts
{
  name: 'read_pdf',
  description:
    'Read text content from the PDF in the active tab. Returns text per page, ' +
    'preserving reading order. Use page_range to read specific pages. Use this ' +
    'instead of read_page when the active tab is a PDF.',
  input_schema: {
    page_range: {
      type: 'string',
      optional: true,
      description: 'Page range, 1-indexed. Examples: "1", "1-3", "1,3,5", "1-3,7". Omit for first page only.',
    },
    max_chars: {
      type: 'number',
      optional: true,
      description: 'Truncate result to this many characters total. Default 8000.',
    },
  },
  output: {
    pages: Array<{ page: number; text: string }>,
    total_pages: number,
    truncated: boolean,
  },
}
```

### 6.2 `search_pdf`

```ts
{
  name: 'search_pdf',
  description:
    'Full-text search the PDF in the active tab. Returns matching pages with ' +
    'surrounding snippets. Use this to find specific terms in large PDFs before reading full pages.',
  input_schema: {
    query: { type: 'string', description: 'Search term (case-insensitive substring match).' },
    max_results: { type: 'number', optional: true, description: 'Default 10.' },
  },
  output: {
    matches: Array<{ page: number; snippet: string; match_offset: number }>,
    total_matches: number,
  },
}
```

Snippet = 命中位置前后各 ~80 字符 + ellipsis；同一页多个命中合成一个 snippet 或返回多条由 `max_results` 控制。

### 6.3 `get_pdf_outline`

```ts
{
  name: 'get_pdf_outline',
  description:
    'Get the PDF outline (table of contents) and metadata for the active tab. ' +
    'Call this first to understand the PDF structure before reading pages.',
  input_schema: {},  // no args
  output: {
    title: string | null,
    total_pages: number,
    outline: Array<{ level: number; title: string; page: number }>,  // empty if PDF has no outline
  },
}
```

### 6.4 LLM 引导

System prompt builder (`src/lib/agent/prompt-builder.ts`) 增加一句：

> If the active tab URL ends in `.pdf` or content-type is `application/pdf`, prefer `read_pdf` / `search_pdf` / `get_pdf_outline` over `read_page`. Start with `get_pdf_outline` for unfamiliar PDFs.

### 6.5 read_page 协同

`read_page` 检测到 PDF tab → 立即返回结构化错误：

```ts
{ error: 'pdf_tab', message: 'This tab is a PDF. Use read_pdf instead.' }
```

LLM 一轮自纠正。**不做** polymorphic 转发。

## 7. file:// permission flow

```
SW 检测 tab.url.startsWith('file://')
  │
  ├─ chrome.extension.isAllowedFileSchemeAccess() === true
  │     → 走正常路径
  │
  └─ false
        → SW post message to sidepanel 'pdf:needs-file-access'
        → sidepanel 渲染 <PdfPermissionCard />
        → 用户点按钮: chrome.tabs.create({url: `chrome://extensions/?id=${chrome.runtime.id}`})
        → 卡片图示标出 "Allow access to file URLs" toggle 位置
        → sidepanel 监听 visibility/focus 事件，回到 sidepanel 时再 check isAllowedFileSchemeAccess()
        → 检测到 true → 卡片消失 → tool 可执行
```

Tool 层同时返回 `{error: 'file_access_denied', user_action_required: true}`，LLM 文本回复用户「请在卡片里完成授权」。

## 8. Error handling

| 场景 | 检测点 | 返回给 LLM |
|------|--------|----------|
| Active tab 不是 PDF | tool entry 调 `isPdfTab(tab)` | `{error: 'not_a_pdf', tab_url}` |
| file:// 但无授权 | `chrome.extension.isAllowedFileSchemeAccess()` | `{error: 'file_access_denied', user_action_required: true}`，同步通知 sidepanel 弹卡 |
| PDF 是扫描件（text layer 空） | parse 后 `pages.every(p => p.text.trim() === '')` | `{error: 'scanned_pdf', message: 'No text layer; OCR not supported in MVP'}` |
| 加密 PDF | LiteParse throw | `{error: 'encrypted_pdf'}` |
| 损坏 / 非法 bytes | LiteParse throw | `{error: 'parse_failed', detail: <message>}` |
| 远程 fetch 失败 (CORS / 404) | `fetch().ok === false` | `{error: 'fetch_failed', status}` |
| 超大 PDF (> 100 MB) | `bytes.byteLength` 检查 | `{error: 'too_large', size_mb}` |
| Offscreen doc 启动失败 | `chrome.offscreen.createDocument` reject | tool 层 throw 一般 Error（非 LLM 可修） |

**page_range 越界**：忽略越界页号，不报错。空 range → 首页。

**Truncation**：`max_chars` 超限按页边界截断 + `truncated: true`，不切到半句。

## 9. Testing strategy

vitest + happy-dom，跟现有 `tools/*.test.ts` 同模式。

| 文件 | 内容 |
|------|------|
| `src/lib/pdf/detect.test.ts` | `isPdfTab` 大小写 / query string / hash fragment / 非 PDF 后缀 |
| `src/lib/pdf/page-range.test.ts` | `"1"`, `"1-3"`, `"1,3,5"`, `"1-3,7"`, 越界忽略, 空 spec → 首页, 反向 `"3-1"` → 空集 |
| `src/lib/agent/tools/pdf.test.ts` | 三个 tool 的 args 校验、错误分支、cache hit/miss 行为（mock offscreen response）、read-class 标记一致性 |
| `src/offscreen/pdf-parser.test.ts` | LiteParse 调用、cache 行为、消息 dispatch；用真实小 fixture (`tests/fixtures/sample.pdf`, 2-3 页文本, <50 KB) |
| `src/__tests__/cross-layer/pdf-flow.test.ts` | SW ↔ offscreen ↔ tool 端到端（mock chrome.offscreen + runtime.sendMessage） |
| `src/__tests__/cross-layer/no-confirm-pdf.test.ts` | 沿用既有约定：pdf tool read-class，绝不触发 confirm 层 |

### 9.1 Build-time invariant 增量

- `tool-names.ts` 加 `read_pdf` / `search_pdf` / `get_pdf_outline` 到 read 集合 → 现有 build 校验自动覆盖每个 tool 必须有 read/write 分类的 invariant

### 9.2 Manual verify checklist

按 `verify` skill 流程：

- [ ] 文本型 PDF（arxiv 论文 URL）：outline + 跨页 search + 指定页读取
- [ ] 扫描件 PDF：返回 `scanned_pdf` 错误，UI 不崩
- [ ] 加密 PDF：返回 `encrypted_pdf`
- [ ] 本地 PDF 首次：弹卡片 → 引导开权限 → 自动恢复
- [ ] 大 PDF (500+ 页)：search/读取页响应 < 3s（PDFium 实测水平）
- [ ] SW 退休 30s 后再问同一 PDF：重新解析、不崩
- [ ] read_page 对 PDF tab 返回 `pdf_tab` 错误，LLM 自纠正用 read_pdf

## 10. Risks & open questions

1. **WASM 加载在 offscreen 是否需要额外配置**：`WebAssembly.compileStreaming(fetch(chrome.runtime.getURL('liteparse.wasm')))` 应该 work，但 LiteParse 的 `init()` 内部如果用 `new URL(..., import.meta.url)` 可能在 offscreen ESM 模式下需要 vite 配置调整。Implementation 阶段先做 PoC。
2. **PDFium WASM 是否需要 COOP/COEP（cross-origin isolation）**：单线程模式不需要，但 LiteParse 如果默认开多线程就要。Implementation 阶段查 LiteParse README 的 threading 选项。
3. **`chrome.offscreen.createDocument` 的 `reasons` 字段**：MV3 要求声明明确 reason，`'BLOBS'` / `'IFRAME_SCRIPTING'` 都可能合适，需 Chrome docs 确认哪个最贴 WASM 解析场景。
4. **Cache invalidation**：MVP 用 `tab.url` 作 cache key。会话内修改并保存 PDF 后再问 Agent 会读到旧 cache。出现就升级为 content hash（已在 5.2 留好升级路径）。
5. **Offscreen 跟 sidepanel 同时存在时的消息路由**：本设计走 SW 作为唯一 bridge（offscreen 不直接跟 sidepanel 通信），保持现有 message hub 模型。

## 11. Out-of-scope future hooks

- **OCR**：LiteParse 已有 OCR callback API。MVP 传空 callback。将来想接 Tesseract.js / vision 模型 OCR，只需替换 callback，不改 tool surface
- **bbox 暴露**：parse 时已缓存 bbox。将来加 `read_pdf` 的 `include_bbox: true` option，offscreen 直接返回，零额外成本
- **页面图像**：`render_pdf_page(n)` tool 用 LiteParse 的 render API → PNG → 喂 vision 模型
- **持久化**：cacheKey 升级为 content hash，存 IndexedDB（参考 skill-store 模式）

## 12. References

- LiteParse v2: https://www.llamaindex.ai/blog/liteparse-v2-0-runs-everywhere
- LiteParse repo: https://github.com/run-llama/liteparse (Apache-2.0)
- LiteParse WASM npm: https://www.npmjs.com/package/@llamaindex/liteparse-wasm
- Chrome offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- 现有 tool 范式: `src/lib/agent/tools/read-page.ts`, `src/lib/agent/tools/search.ts`
