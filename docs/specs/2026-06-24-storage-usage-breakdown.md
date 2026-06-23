# 存储用量 per-session 明细面板（issue #153 切片①）

**日期**: 2026-06-24
**Issue**: WiseriaAI/pie-ai-agent#153 — P2 · feature
**范围**: 只做 triage 建议顺序的**第一项 = per-session 用量明细**（点存储条展开，按会话列出字节占用）。批量清理（②）、按 store 明细（③）、清理建议留后续切片，不在本 PR。

## 现状（勘察结论）

- `StorageIndicator` 是 `SessionDrawer.tsx:52-91` 里的局部组件，底部一行显示总用量 `X.X MB`（`getTotalBytes()` = `navigator.storage.estimate().usage`，fallback 为各 store JSON 字节），`useStoreChange("sessions"|"config"|"instances")` 时重读。
- sessions store：`keyPath:"id"`，记录形状 `{ id, value }`，id 形如 `${sid}:meta` / `${sid}:agent` / `${sid}:archived`（`:agent`=原始消息历史，是大头）。索引在**另一个** store `session_index`。
- `listSessionIndex()` 返回**全部**会话（含 archived，不按 status 过滤；UI 层才分 active/archived）的 `SessionIndexEntry[]`（`{id,title?,status,lastAccessedAt,...}`），按 lastAccessedAt 降序。
- 现成可复用：`tx(store,mode,fn)`（`@/lib/idb/db`）、`humanSize(bytes)`（`@/lib/files/mime-label`，输出 B/KB/MB）、`Collapse`（`ui/Collapse`，height 0↔auto 动画）、`useStoreChange`、`useT`。

## 设计

### 数据 API（`src/lib/sessions/storage.ts` 新增）

```ts
export interface SessionByteEntry {
  id: string;
  title?: string;
  status: SessionStatus;
  bytes: number;
}

export async function listSessionsWithBytes(): Promise<SessionByteEntry[]>;
```

实现：**一次** `getAll` over sessions store，按 id 去掉 `:(meta|agent|archived)$` 后缀分桶累加 `JSON.stringify(rec).length`；与 `listSessionIndex()` join 取 title/status；按 bytes 降序。**一次 IDB 读覆盖所有会话**（而非每会话 3N 次读）。bytes 是估算（注释说明非精确磁盘字节，`:agent` 历史是大头）。archived 会话天然包含（listSessionIndex 不过滤）。

### UI（把 StorageIndicator 抽成独立可展开组件）

把 `SessionDrawer.tsx` 内联的 `StorageIndicator` 抽到新文件 **`src/sidepanel/components/StorageIndicator.tsx`**（SessionDrawer 偏大，顺手改进 + 让组件可单测），并扩展为「点存储条展开 per-session 明细」：

- 顶部一行改为**可点击 toggle**（`<button>` + `aria-expanded`）：左 `STORAGE` 标签（复用 `t("sessions.storage")`）、右总用量 `X.X MB`（不变）、加一个旋转 chevron。
- 下方 `<Collapse open={expanded}>` 内一个**可滚动**（`maxHeight ~240px, overflowY:auto`）`<ul>`：每行 = 会话 title（`title ?? t("sessions.untitled")`，单行省略）+ 右侧 `humanSize(bytes)`（Mono 小字）。按 bytes 降序。
- **懒加载**：仅展开时调 `listSessionsWithBytes()`；展开态下 `useStoreChange("sessions")` 重读。总用量行仍走原 `getTotalBytes()`（不变）。
- 样式严格沿用既有 token（`--c-fg-1/2/3`、`--c-line`、Mono 10px 标签）与 SessionRow 行范式。
- a11y：toggle `aria-expanded` + `aria-controls`；列表 `role="list"` / 行 `role="listitem"`。

`SessionDrawer.tsx`：删局部 `StorageIndicator` 函数，改 `import { StorageIndicator } from "./StorageIndicator"`。

### 无新 i18n key

toggle 复用 `sessions.storage`，行用 `sessions.untitled`，字节走 `humanSize`（非文案）。**不加新 key**（避开 6 语言字典 + parity 改动）。

## 测试

- `storage.test.ts`：`listSessionsWithBytes` —— 建 2 个会话（一个写更大的 agent 历史），断言返回按 bytes 降序、bytes>0、含 title/status、archived 会话也在内。
- `StorageIndicator.test.tsx`（新）：mock `listSessionsWithBytes` 返回固定两行 → 渲染 → 初始折叠（明细不可见）→ 点 toggle → 展开后两行 title + humanSize 可见、`aria-expanded` 变 true。

## 验收标准

- 点击存储条展开，按会话列出字节占用、降序；总用量行不变。
- `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿；i18n parity 不破（无新 key）。
- 真机：打开会话抽屉，点存储条，看到各会话占用，消息多的会话排前（人工验收）。

## 明确排除（后续切片）

- 批量清理动作（清理所有已归档 / 批量选删）—— triage ②。
- 按 store（sessions/instances/config/output-files）拆分明细 —— triage ③。
- 用量高时的清理建议按钮、`navigator.storage.persist()` 评估。
- 精确磁盘字节（本切片是 `JSON.stringify` 估算，面板措辞不声称精确）。
