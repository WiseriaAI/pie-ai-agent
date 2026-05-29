# 本地文件读写 (Local File I/O)

- **Date**: 2026-05-29
- **Status**: Design (awaiting review)
- **Scope**: 让 Pie 能从本地读取文件喂给 LLM,并把 LLM 产出写回本地。

---

## 1. 目标与范围

### In scope

1. **读·喂资料给 agent** — 用户提供本地文件(文本/代码、PDF、图片),内容进上下文供 LLM 分析/总结/问答。
2. **写·agent 产出落盘** — LLM 生成的内容(报告、代码、markdown)写到本地,方便用户取用。

### Out of scope (YAGNI)

- 常驻"工作目录"(agent 在某个本地目录里反复读写)。
- 批处理(agent 自主遍历目录里多个文件)。
- Office 文档(docx/xlsx)解析。
- 任意路径写入(写出统一落到下载目录)。
- Native Messaging。

### 已确认的产品决策

| 维度 | 决策 |
|---|---|
| 核心场景 | 读(喂资料) + 写(产出落盘) |
| 读取触发 | 用户主动 **和** agent 主动(human-in-loop)都要 |
| 读取选定方式 | `file://` URI(tab/路径) **和** Finder 弹窗(字节)都支持 |
| 读取类型 | 纯文本/代码、PDF、图片(不含 Office) |
| 写出落点 | `chrome.downloads` → `Downloads/pie/`(自动落盘,不支持任意目录) |
| UI 入口 | 全部并入 composer 的 `+`(`ToolsMenu`);把现有"附加图片"项替换为统一的"附加文件",旧图片能力作为子集保留 |

---

## 2. 关键技术约束(设计的地基)

1. **谁能调文件 API**
   - Service Worker(agent loop 所在):无 window / 无用户手势 → **不能**调任何 file picker;**能**调 `chrome.downloads`、能 `fetch('file://...')`。
   - Side Panel(UI):有 window / 有用户手势 → **能**调 `<input type=file>` / file picker。
2. **Finder 弹窗拿不到路径** — `<input type=file>` / `showOpenFilePicker` 返回的是 `File`(字节),浏览器故意不暴露 `file://` 绝对路径。所以"从 Finder 选" 与 "用 `file://` URI 读" 是两条互斥输入,必须分别支持。
3. **`file://` fetch 已验证可用** — offscreen 现在就是 `fetch(file://url)` 解析 PDF tab(`isFilePdfUrl` pin-gate);`fetch` 对文本/图片同样成立。前提是用户在 `chrome://extensions` 开启 **"允许访问文件 URL"**。
4. **offscreen PDF parser 当前按 URL** — `getParsed(url)` 内部 `fetchImpl(url)` 并按 url 缓存。Finder 选来的 PDF 没有可跨上下文 fetch 的 URL(blob URL 不跨上下文),因此需要给 offscreen 协议新增"按字节解析"变体。
5. **MV3 SW 无 `URL.createObjectURL`** — 写出时不能用 object URL,改用 `data:` URL 承载 content 传给 `chrome.downloads.download`。
6. **已有可复用轨道**
   - `ImageAttachment`(`src/lib/images/types.ts`)+ Phase 5 vision 通道 + 缩略图行 + resize。
   - `<untrusted_*>` wrapper 体系(`untrusted-wrappers.ts` + `page-snapshot.ts` 双表)。
   - offscreen `parseBytes` / 缓存 / 消息 bridge(`offscreen-manager.ts`)。
   - `pdf:needs-file-access` 广播 + `<PdfPermissionCard>` 权限引导。
   - `tool-names.ts` read/write 分类(build-time invariant)。

---

## 3. 架构总览

新增 **3 个 tool + 1 个共享处理模块**,改造 composer `+` 菜单,扩展 offscreen 协议。

```
读·用户发起   +菜单"附加文件" ─pick→ processPickedFile ─分流→ 暂存 chip ─随消息发→ SW
读·agent发起  tool request_local_file ─→ SW→panel 挂起请求 ─用户点选→ processPickedFile ─→ tool result
读·file:// URI tool read_local_file(uri) ─→ SW fetch(file://) ─分流(text/img/pdf)→ tool result
写·agent发起  tool save_to_downloads ─→ SW data:URL ─→ chrome.downloads ─→ Downloads/pie/
```

| 单元 | 形态 | 触发方 | 执行上下文 |
|---|---|---|---|
| `read_local_file` | tool (read-class) | agent 自主 | SW (+offscreen for PDF) |
| `request_local_file` | tool (read-class) | agent→人 (human-in-loop) | SW → panel `<input>` |
| `save_to_downloads` | tool (write-class) | agent 自主 | SW |
| `+` 菜单"附加文件" | UI | 用户 | panel `<input>` |
| `processPickedFile` | 共享模块 | — | panel |

下游统一:文本/PDF 文本 → 包 `<untrusted_local_file>` 注入;图片 → vision content block。

---

## 4. 单元详细设计

### 4.1 `read_local_file`(file:// URI 读取,agent 自主)

- **class**: read
- **入参**: `{ uri: string }` — `file:///abs/path` 或绝对路径(内部 normalize 成 `file://`)。可选 `pages`(PDF,复用 `parsePageRange`)。
- **流程(SW)**:
  1. normalize → `fetch(file://uri)`。失败且原因疑似权限 → 触发 `needs-file-access` 广播,返回可自纠的错误文本。
  2. 按 `Content-Type` / 扩展名分流:
     - 文本/代码 → `response.text()` → 截断 → 包 `<untrusted_local_file name mime>` 作为 tool result。
     - PDF → 走**现有** offscreen `pdf:read_page { url }`(零改动) → 文本 → 同样包 wrapper。
     - 图片 → `arrayBuffer` → base64 → vision content block 回灌(受 instance vision 能力限制;无 vision 则返回可自纠错误)。
- **前提**: "允许访问文件 URL" 开关。未开 → 复用 `pdf:needs-file-access` 机制(泛化命名为 `needs-file-access`)+ `<PdfPermissionCard>` 模式提示。

### 4.2 `request_local_file` + `+` 菜单(Finder 弹窗读取)

共享 panel 侧模块 **`processPickedFile(File)`**:

| 文件类 | 处理 | 产物 |
|---|---|---|
| 图片 | 复用现有 resize 管线 | `ImageAttachment`(vision 通道) |
| 文本/代码 | `file.text()` → 截断 | `FileAttachment`(新 kind) |
| PDF | `arrayBuffer()` → offscreen `pdf:parse_bytes` | `FileAttachment`(text) |

**A. `+` 菜单"附加文件"(用户发起)**
- `ToolsMenu` 中现有"附加图片"项 → 改为 **"附加文件"**。
- 隐藏 `<input type=file multiple>` 的 `accept` 从 image-only 改为全类型(images + 常见文本/代码扩展 + pdf)。
- 去掉 `attachDisabled = !supportsVision` 全局禁用;改为选完之后按类型分流:图片在无 vision 时单独 warn 丢弃,文本/PDF 照常。
- `onPasteFiles` / `onDropFiles` 一并改走 `processPickedFile`(拖/粘贴 PDF、文本也能附加)。
- **Chip 行**:保留现有图片缩略图行;新增 **FileChip 行**(文件名 + 类型图标 + ×,样式对齐 `QuoteChip`)渲染 `FileAttachment`。
- **上限**:`MAX_IMAGES_PER_TURN` 图片上限保留;给非图片文件单独的数量上限 + 总字节上限。

**B. `request_local_file`(agent 发起,human-in-loop)**
- **class**: read。
- agent 调用 → SW 发"挂起文件请求"给 panel → panel 渲染一张"agent 想读取文件,点此选择"卡片(用户这一**点**补上 picker 必需的用户手势)→ `<input>` → `processPickedFile` → 结果回传成 tool result。
- **panel 必须打开**:panel 关闭/无响应 → tool 返回可自纠错误(提示 agent 改用 `read_local_file` 或让用户主动附件)。

### 4.3 `save_to_downloads`(写出,agent 自主)

- **class**: write → 触发 R7 跨 session 锁。
- **入参**: `{ filename: string; content: string; mime?: string }`。`filename` 强制相对、落在 `pie/` 子目录下(剥离 `../` 等越界)。
- **流程(SW)**:
  1. 由 `content`(+ `mime`,默认 `text/plain`)构造 `data:` URL(`URL.createObjectURL` 在 SW 不可用)。
  2. `chrome.downloads.download({ url, filename: 'pie/' + name, conflictAction: 'uniquify', saveAs: false })`。
  3. `uniquify` 天然防覆盖(同名自动 `(1)`);返回最终落点/文件名给 agent。
- **manifest**: 新增 `downloads` permission。

---

## 5. 数据结构

### 5.1 `FileAttachment`(新)

`src/lib/files/types.ts`(或并入 images 同级):

```ts
export interface FileAttachment {
  kind: "file";
  id: string;
  name: string;       // 原文件名
  mime: string;       // text/markdown / application/pdf / ...
  text: string;       // 提取后的文本(已截断)
  truncated: boolean; // 是否被截断
  totalChars: number; // 截断前原始字符数(供提示)
  source: "picker" | "uri"; // 来源
}
```

- 暂存于 composer 的 pending 状态,随下条 user message 发送(类比现有 `attachments?: ImageAttachment[]` / `quotes?: Quote[]`)。
- 发送时注入最后一条 user ChatMessage,包 `<untrusted_local_file name="…" mime="…" truncated="…">…</untrusted_local_file>`。
- 持久化:与 `attachments`/`quotes` 一致的处理(display message 携带,panel render 用)。

### 5.2 offscreen 协议扩展

`offscreen-manager.ts` `OffscreenRequest` 新增:

```ts
| { type: "pdf:parse_bytes"; bytes: ArrayBuffer; cacheKey: string; pages?: number[] }
```

- `cacheKey` = content hash(内容寻址,避免不同 File 撞 url-key);复用现有 `parseBytes` + cache + 解析核心。
- 返回结构对齐现有 `pdf:read_page` 的文本产物。

---

## 6. 横切关注点

- **Prompt injection 防御**:所有读入文本是 untrusted → 一律包 `untrusted_local_file`,**绝不**进 system role。新增 wrapper 必须在双表注册:`UNTRUSTED_WRAPPER_TAGS`(`untrusted-wrappers.ts`)与 `WRAPPER_TAGS_LIST`(`page-snapshot.ts`)(dual-list invariant)。图片走 vision block,不需文本 wrapper。
- **read/write 分类**:`read_local_file` / `request_local_file` = read;`save_to_downloads` = write。三者在 `tool-names.ts` 声明 class(build-time invariant,漏声明会 throw)。
- **截断策略**:文本/PDF 文本按字符预算截断,末尾标注 `…[truncated N/total chars]`;图片复用现有 resize。预算具体值在 plan 阶段定(初值建议 ~50KB 字符/文件,可调)。
- **权限**:
  - `file://` 读取靠用户"允许访问文件 URL"开关(不改 manifest),复用 `needs-file-access` 广播 + `PdfPermissionCard` 模式。
  - 写出加 `downloads` permission(manifest)。
- **manifest 改动**:仅新增 `"downloads"` 到 `permissions`。
- **错误自纠**:tool 失败返回明确文本(权限未开 / panel 未开 / 类型不支持 / 无 vision),让 LLM 自行改道。

---

## 7. 受影响文件(预估)

- `manifest.json` — 加 `downloads` permission。
- `src/lib/agent/tools/files.ts`(新)— `read_local_file` / `request_local_file` / `save_to_downloads` handlers。
- `src/lib/agent/tools.ts` / `tool-names.ts` — 注册 + read/write 分类。
- `src/lib/files/`(新)— `FileAttachment` 类型 + `processPickedFile`(panel 侧)+ 截断/分流工具。
- `src/lib/agent/untrusted-wrappers.ts` + `src/lib/agent/page-snapshot.ts` — 注册 `untrusted_local_file`。
- `src/background/offscreen-manager.ts` + `src/offscreen/pdf-parser.ts` — `pdf:parse_bytes` 变体。
- `src/sidepanel/components/Chat.tsx` — `ToolsMenu`"附加图片"→"附加文件"、`<input accept>`、分流、FileChip 行、paste/drop generalize、`request_local_file` 挂起卡片。
- `src/sidepanel/components/FileChip.tsx`(新)。
- `src/types/` — 消息协议(SW↔panel 挂起文件请求、`FileAttachment` on message)。
- 权限引导:`PdfPermissionCard` / `usePdfPermission` 泛化为 file-access。

---

## 8. 测试要点

- `save_to_downloads`:`data:` URL 构造、`pie/` 前缀强制、`../` 越界剥离、`uniquify` 防覆盖。
- `read_local_file`:MIME 分流、file:// 权限缺失的错误路径、PDF 走现有 offscreen。
- `processPickedFile`:三类分流、图片无 vision 丢弃、截断标注。
- offscreen `pdf:parse_bytes`:字节解析与缓存命中。
- 跨层:`untrusted_local_file` 双表注册 invariant;read/write 分类 invariant;write-class 触发 R7 锁。
- UI:`+` 菜单"附加文件"全类型、FileChip 渲染/移除、paste/drop 非图片文件。

---

## 9. 实施阶段建议(供 plan 细化)

1. **写出 MVP** — `save_to_downloads` + `downloads` permission(改动最小、价值即得)。
2. **file:// 读取** — `read_local_file`(文本/图片新增,PDF 复用现有)+ 权限引导泛化。
3. **offscreen 字节变体** — `pdf:parse_bytes`(为 Finder PDF 铺路)。
4. **Finder 读取 + UI** — `processPickedFile` + `+` 菜单替换 + FileChip + `request_local_file`。
