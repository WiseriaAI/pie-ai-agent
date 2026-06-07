# Output File Card — 用户触发下载（替换即调即下的 save_to_downloads）

**日期**：2026-06-07
**状态**：设计已确认，待写实施计划
**Paper 原型**：`Pie Frontend` 文件 · 画板「NEW — Output File Card · Light + Dark」

## 1. 背景与问题

当前 `save_to_downloads` 工具（`src/lib/agent/tools/files.ts`）的行为是**调用即落盘**：LLM 一调用，handler 立刻在 background service worker 里执行
`chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs })`，文件马上写入 `Downloads/pie/`。`save_as` 默认 `false`，所以默认不弹任何对话框、用户毫无介入。side panel 里这个工具结果只渲染成一行普通 observation 文本，没有任何专门 UI。

这带来三个问题：

1. 用户对"要不要下、下什么"没有可见的确认点——文件悄悄落盘。
2. 默认不弹"另存为"，用户无法选择保存位置。
3. 模型产出的文件在侧栏没有任何呈现，用户看不到标题/类型就已经被下载了。

## 2. 目标

把"工具调用"与"实际下载"**解耦**：

1. 模型产出文件后，工具调用只产生一个"待下载产物"，在 side panel 渲染成一张**文件卡片**（文件名 + 类型 + 大小 + 下载按钮）。
2. 用户点击卡片上的**下载按钮**才真正触发下载。
3. 下载时弹出系统"另存为"对话框，用户**自行选择保存位置**（不再静默落盘到固定目录）。

### 非目标（YAGNI）

- 不做产物的持久化。卡片内容只在**任务期间 + SW 存活期间**有效，SW 空闲回收 / 重启后内容丢失（与现有截图 `image-cache` 的生命周期一致）。**不引入 IndexedDB。**
- 不做卡片内的富文本/语法高亮预览。视觉精简为单行卡（见 §5），不展示正文预览块。
- 不改动生成图片（image output）那条独立链路，本 spec 只覆盖文本类文件产物。
- 不做"下载历史"面板。

## 3. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 卡片/产物生命周期 | 任务期间有效，**SW 空闲/重启后失效**（in-memory，不持久化） |
| 工具改名 | `save_to_downloads` → **`output_file`** |
| `save_as` 参数 | **删除**（保存位置统一由用户点卡片时的"另存为"决定，参数已无意义） |
| 下载触发位置 | **在 SW**（panel 发消息给 SW，SW 调 `chrome.downloads`），避免把可能数 MB 的内容回传 panel |
| 选择保存位置 | 复用 `chrome.downloads.download({ saveAs: true })`——必弹"另存为" |
| 卡片视觉 | 紧凑单行卡，下载按钮在同一行；不含正文预览块 |
| 工具 read/write 分类 | **read 类**（调用时不触碰页面/tab/磁盘，不参与 R7 跨 session tab 写锁） |

## 4. 架构与数据流

```
LLM 调用 output_file({ filename, content, mime })
        │
        ▼
[SW] outputFileTool.handler
   1. 复用现有校验：sanitizeDownloadName / SAFE_MIME 白名单 / MAX_CONTENT_BYTES(5MB)
      —— 任一不过：在调用阶段直接 fail（不产卡），observation 告知 LLM 原因
   2. 生成 artifactId，把 { id, sessionId, filename, mime, content, byteLength, addedAt }
      存进新的 output-cache（in-memory、session 维度、仿 image-cache 的 LRU + 字节预算）
   3. 返回 ActionResult，新增结构化字段 fileOutput:
      { id, filename, mime, size }
   4. observation 文本告诉 LLM：文件已交给用户、等其在侧栏点击下载（不要假定已保存）
        │
        ▼
[loop.ts] emitStep 附近：检测到 result.fileOutput
   → agent-step 照常 emit（让 LLM 调用在步骤流里有迹可循）
   → 额外 emit 一条 file-output port 消息给 panel
        │
        ▼
[panel] port-handler 收到 file-output → push 成 DisplayMessage(role:"file-output")
   → Chat.tsx buildSegments 让它像 user/assistant 一样打断 step 折叠组，单独渲染
   → <FileOutputCard>：图标 + 文件名 + 「类型 · 大小」+ 下载按钮
        │
   用户点[下载]
        ▼
[panel] → runtime message { type:"download-output", sessionId, artifactId } → [SW]
        │
        ▼
[SW] 查 output-cache：
   命中  → chrome.downloads.download({ url: data-uri, filename, saveAs: true })
           saveAs:true ⇒ 必弹"另存为"，用户自选位置
   未命中 → 回 { ok:false, reason:"expired" }，卡片切到 expired 禁用态
```

**核心复用点**：
- `chrome.downloads.download({ saveAs:true })` 原生支持"另存为选位置"。
- `src/background/image-cache.ts` 已提供 in-memory + LRU + session 驱逐范式，新 `output-cache.ts` 照搬其结构与驱逐路径（任务终止 / SW 重启 / 切换 active session）。

## 5. 卡片 UI（视觉规格）

紧凑单行卡，下载按钮内联在同一行。**不含正文预览块。**严格使用 Foundations token。

布局：
```
┌────────────────────────────────────────────────┐
│ [icon]  weekly-report.md            [ ↓ 下载 ]  │
│         MARKDOWN · 12.3 KB                       │
└────────────────────────────────────────────────┘
  40×40    flex:1, min-width:0          flex-shrink:0
  图标槽    文件名(Inter 14/500) +       下载按钮
           「类型·大小」(JetBrains Mono 11)
```

元素：
- **图标槽**：40×40 圆角方块，tinted 底（暗 `#1A1E25` / 浅 `#F2F3F5`），内嵌文档 SVG 图标（暗用 ice-silver `#B8C0C6` 描边）。`flex-shrink:0`。
- **文件名**：Inter 14px / 500，`text-1`（暗 `#E5E0EC`），单行省略号截断。
- **类型 · 大小**：JetBrains Mono 11px，`text-2 #8A929E`；类型由 mime 映射成友好大写标签（`text/markdown→MARKDOWN`、`application/json→JSON`、`text/csv→CSV`、`text/plain→TEXT`…）。
- **下载按钮**：内联在同一行，`flex-shrink:0`，下载箭头 SVG + 「下载」。暗色用 ice-silver 反白（底 `#B8C0C6` + 字 `#14111C`，呼应 Send 按钮）；浅色用深色实心（底 `#16181C` + 白字）。

### 状态机

| 状态 | 视觉 | 触发 |
|---|---|---|
| `idle` | 正常，按钮可点 | 卡片初始渲染 |
| `downloading` | 按钮禁用（防重复触发） | 点击下载、等待 SW 回应 |
| `idle`（回退） | 恢复可点 | 另存为对话框被用户取消（download reject，不算错误） |
| `expired` | 整卡转灰、按钮禁用、caption 换「已过期 · 让助手重新生成」 | SW 缓存已驱逐，下载请求 miss |
| `error` | 按钮回 idle，附简短错误提示 | `chrome.downloads` 抛非取消类错误 |

文案走现有 i18n（参考 `agentStep.*` key 加法），中英各一份。

## 6. 边界与错误处理

| 场景 | 处理 |
|---|---|
| 缓存被驱逐后点下载 | SW miss → 回 `expired`，卡片切禁用态，不弹窗报错 |
| 超 5MB / 非白名单 mime | 沿用现有校验，**工具调用阶段即 fail**，不产卡，observation 告知原因 |
| 同名文件 | 不再有"自动加后缀"问题——`saveAs:true` 弹框由用户决定覆盖/改名 |
| 下载中重复点击 | 进 `downloading` 禁用态，防重复 `chrome.downloads` |
| 用户取消另存为 | download reject → 卡片回 `idle`，可重试，不算错误 |
| task 已结束但 SW 仍活 | 卡片仍可下载（缓存还在）；SW 回收后才转 `expired` |
| panel 刷新后（SW 仍活） | 卡片作为 DisplayMessage 在 panel 内存消息列表中；本次会话视图内保留。完全重载不强求重建卡片（与"任务期间有效"生命周期一致）|

## 7. 改动清单

### 新增

1. **`src/background/output-cache.ts`** — in-memory 产物缓存，照搬 `image-cache.ts`：
   - `FileArtifact { id, sessionId, filename, mime, content, byteLength, addedAt }`
   - `addArtifact / getArtifact(sessionId,id) / evictSession / evictAllOnSWStartup / evictOnSetActive`
   - `SESSION_BYTE_BUDGET`（如 10MB）+ 数量上限的 LRU 驱逐；驱逐路径与 image-cache 对齐
2. **`src/sidepanel/components/FileOutputCard.tsx`** — 卡片组件（§5 视觉 + 状态机），props 含 `{ id, filename, mime, size, state }` 与 `onDownload(id)`；mime→友好标签的小工具函数。

### 改动

3. **`src/lib/dom-actions/types.ts`** — `ActionResult` 加可选 `fileOutput?: { id; filename; mime; size }`（text-only 通道之外的结构化产物出口；最小侵入，避免在 loop 里整段特判一个工具）。
4. **`src/lib/agent/tools/files.ts`** — `saveToDownloadsTool` → `outputFileTool`：
   - `name:"output_file"`，删 `save_as` 参数及分支
   - handler 不再调 `chrome.downloads`；改为 `addArtifact(...)` + 返回 `fileOutput` + 新 observation
   - **保留** `sanitizeDownloadName` / `SAFE_MIME` / `MAX_CONTENT_BYTES` 全部校验
   - 同步：`LOCAL_FILE_TOOLS` 数组、引用旧名的 prompt
5. **`src/lib/agent/tool-names.ts`** — `output_file` 登记为 **read 类**；移除 `save_to_downloads`。
6. **`src/types/messages.ts`** — 新增 `FileOutputMessage`（port→panel）并入 `PortMessageToPanel`；`DisplayMessage` 加 `role:"file-output"` 变体（携带 id/filename/mime/size/state）。
7. **`src/lib/agent/loop.ts`** — `emitStep` 附近：`result.fileOutput` 存在时额外 emit `file-output` port 消息。
8. **`src/sidepanel/hooks/useSession/port-handlers.ts`** — `handleMessage` 加 `file-output` 分支，push 成 DisplayMessage。
9. **`src/sidepanel/components/Chat.tsx`** — `buildSegments` 让 `file-output` 打断 step 分组、单独渲染 `<FileOutputCard>`；接 `onDownload(id)` → 发 `download-output` runtime 消息；处理 SW 回 `expired` 切状态。
10. **SW runtime 消息路由（`src/background/index.ts` 或现有路由处）** — 处理 `download-output`：查 `output-cache` → `chrome.downloads.download({ url, filename, saveAs:true })`；miss 回 `expired`。

### i18n

11. 新增卡片文案 key（下载 / 已过期 / 让助手重新生成 / 类型标签等），中英各补一份（遵循 dual-README/dual-i18n 约定）。

## 8. 测试点

- `output-cache` 的 LRU / 各驱逐路径单测（仿 image-cache 测试）。
- `output_file` handler：校验保留（超限/坏 mime fail）+ 成功时产出 `fileOutput` 结构 + 不再调用 `chrome.downloads`。
- `download-output` 路由：命中 → 触发 `chrome.downloads.download({saveAs:true})`；未命中 → 回 `expired`。
- 旧名 `save_to_downloads` 全仓引用清理无残留（`tool-names.ts` 分类、prompt、测试、文档）。
- 现有针对 `save_to_downloads` 的测试改写到 `output_file` 新语义。

## 9. 提交前门禁

`pnpm test`、`pnpm typecheck`、`pnpm build` 全绿（build-time invariant：每个 tool 必须在 `tool-names.ts` 声明 read/write class，否则 throw）。
