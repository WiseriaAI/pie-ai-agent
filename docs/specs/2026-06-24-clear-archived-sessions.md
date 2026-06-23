# 清理所有已归档会话（issue #153 切片②）

**日期**: 2026-06-24
**Issue**: WiseriaAI/pie-ai-agent#153 — P2 · feature
**范围**: triage 建议顺序的**第二项 = 批量清理「删除全部已归档」**。承接切片①（PR #219 per-session 明细）。批量多选删除 / 按 store 明细 / 清理建议留后续，不在本 PR。

## 现状（勘察结论）

- `SessionDrawer.tsx`：archived 区是「Show Archived · N」可折叠 toggle（行 357-405）+ 展开列表（行 408-441），每个 `ArchivedRow` 有 per-row「Restore / Delete」；`handleDeleteForever(id)` 直接调 `hardDeleteSession(id)`（行 248-250，**非 prop**）。archived 会话 = `sessions.filter(s => s.status === "archived")`（props，行 231）。删除后靠 App 层 `useStoreChange("sessions")` 重读 index → 刷新 props（SessionDrawer 无需自刷新）。
- `lifecycle.ts`：`hardDeleteSession(id)`（行 195-210）= readIndexRaw → writeAtomic 删 `:meta/:agent/:archived` + 更新 index → best-effort `deleteSessionArtifacts` + `deleteScratchpad`。`hardDeleteExpired`（行 222-276）是现成批删范式（同一套 atomic batch，但只清 scratchpad、未清 artifacts）。`readIndexRaw()` 返回含 archived 的全量 index。
- 二次确认现成范式：`Settings.tsx:118` 用原生 `window.confirm(t(...))`。

## 设计

### lifecycle：抽共享批删核心（DRY）

抽出 `hardDeleteSessions(ids: string[]): Promise<{ deleted: number }>`：一次 atomic batch 删所有 id 的 `:meta/:agent/:archived` + 更新 index，再 best-effort `deleteSessionArtifacts` + `deleteScratchpad` 每个 id。让三个删除路径都复用它（消除 3 份批删逻辑块）：
- `hardDeleteSession(id)` → `hardDeleteSessions([id])`（行为等价：现实现就是单 id 版的这套）。
- `hardDeleteExpired(now?)` → 算出 `toDelete` 后 `return hardDeleteSessions(toDelete)`（**额外**给 expired 路径补上 artifacts 清理，是安全的一致性改进；现有 expired 测试守护行为）。
- 新增 `hardDeleteAllArchived(): Promise<{ deleted: number }>` → `readIndexRaw()` 筛 `status === "archived"` 的 id → `hardDeleteSessions(ids)`。

### UI：archived 列表内「删除全部」按钮 + 二次确认

在 `SessionDrawer.tsx` 的 archived 列表（`#archived-session-list` 内、`<ul>` 之上）加一个 header 行，仅当 `archivedSessions.length > 0` 显示一个右对齐的危险样式小按钮（`--c-danger-fg`/`--c-danger-line`，Mono 10px，同 per-row Delete 风格）。点击：

```ts
async function handleClearAllArchived() {
  if (!window.confirm(t("sessions.deleteAllArchivedConfirm", { count: archivedCount }))) return;
  await hardDeleteAllArchived();
  // store-bus → App useStoreChange → 重读 index → props 刷新，archived 区变空。
}
```

`hardDeleteAllArchived` 加进 SessionDrawer 已有的 `@/lib/sessions/lifecycle` import 行（与 #219 改动不同区，冲突面近零）。

### i18n：只加 2 个 key × 6 语言

复用 parity 约束（dictionary-parity.test 守 6 语言键对齐）。新增（用词对齐各 locale 既有 `archivedAria`/`showArchived` 术语）：

| key | en | zh-CN | zh-TW | es-419 | ja | pt-BR |
|---|---|---|---|---|---|---|
| `deleteAllArchived` | Delete all | 全部删除 | 全部刪除 | Eliminar todas | すべて削除 | Excluir todas |
| `deleteAllArchivedConfirm` | Permanently delete all {count} archived sessions? This cannot be undone. | 永久删除全部 {count} 个已归档会话？此操作无法撤销。 | 永久刪除全部 {count} 個已封存的工作階段？此操作無法復原。 | ¿Eliminar permanentemente las {count} sesiones archivadas? Esto no se puede deshacer. | アーカイブ済みセッション {count} 件をすべて完全に削除しますか？この操作は元に戻せません。 | Excluir permanentemente todas as {count} sessões arquivadas? Isso não pode ser desfeito. |

按钮可见文本即无障碍名（不另加 aria key）。

## 测试

- `lifecycle.test.ts`：`hardDeleteAllArchived` —— 建 2 个会话各 archive、1 个 active；调用后 2 个 archived 的记录 + index 条目全删、active 不动、返回 `{deleted:2}`；空 archived 时返回 `{deleted:0}`。（顺带：现有 `hardDeleteSession`/`hardDeleteExpired` 测试不变绿，守护重构。）
- `SessionDrawer.test.tsx`：module-mock spy `hardDeleteAllArchived` + stub `window.confirm`：confirm=true 点「Delete all」→ 调用；confirm=false → 不调用；archived 为空时按钮不渲染。

## 验收标准

- archived 区有「删除全部」按钮，二次确认后批量硬删全部已归档、列表刷新为空；active 会话不受影响。
- `pnpm test`（含重构后 hardDeleteSession/hardDeleteExpired 旧测试绿）/ `pnpm typecheck` / `pnpm build` 全绿；i18n parity 通过。
- 真机：归档几个会话 → 展开 archived → 点删除全部 → 确认 → 全部消失（人工验收）。

## 明确排除（后续切片）

- 批量**多选**删除（need 多选态 UI）—— triage 明确「可后做」。
- 按 store 用量明细 —— triage ③。
- 清理建议按钮 / `navigator.storage.persist()`。
