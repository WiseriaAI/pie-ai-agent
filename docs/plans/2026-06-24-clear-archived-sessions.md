# 清理所有已归档会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** archived 区加「删除全部已归档」按钮（`window.confirm` 二次确认），批量硬删全部 archived 会话。issue #153 切片②。

**Architecture:** lifecycle 抽共享批删核心 `hardDeleteSessions(ids)`，三个删除路径复用；SessionDrawer archived 区加按钮 + handler；i18n 加 2 key × 6 语言。复用 store-bus 自动刷新。

**Tech Stack:** React 19 + TS、vitest + happy-dom + @testing-library/react、fake-indexeddb。

## Global Constraints

- DRY：`hardDeleteSession` / `hardDeleteExpired` / `hardDeleteAllArchived` 三者共用 `hardDeleteSessions(ids)`，不重复批删逻辑块。
- 二次确认用原生 `window.confirm`（复用 `Settings.tsx` 范式）。
- i18n：dictionary-parity.test 强制 6 语言键对齐——新 key 必须加到全部 6 个字典。
- 不退化：现有 `hardDeleteSession` / `hardDeleteExpired` 测试保持绿（守护重构）。
- 提交前：`pnpm test`、`pnpm typecheck`、`pnpm build` 全绿。

---

### Task 1: lifecycle 抽核心 + hardDeleteAllArchived

**Files:**
- Modify: `src/lib/sessions/lifecycle.ts`
- Test: `src/lib/sessions/lifecycle.test.ts`

**Interfaces:**
- Consumes（已 import 于 lifecycle.ts:32-44）：`writeAtomic` / `metaKey` / `agentKey` / `archivedKey` / `readIndexRaw` / `INDEX_KEY`（`./storage`）、`deleteSessionArtifacts`（`@/lib/files/output-store`）、`deleteScratchpad`（`../scratchpad/store`）。
- Produces：`hardDeleteSessions(ids: string[]): Promise<{ deleted: number }>`、`hardDeleteAllArchived(): Promise<{ deleted: number }>`。

- [ ] **Step 1: 写失败测试**

`lifecycle.test.ts`：import 列表里给 `./lifecycle` 加 `hardDeleteAllArchived`；末尾追加：

```typescript
describe("hardDeleteAllArchived", () => {
  it("hard-deletes every archived session and leaves active ones", async () => {
    const a = await createSession();
    const b = await createSession();
    const c = await createSession();
    await archiveSession(a.id);
    await archiveSession(b.id);
    // c stays active

    const result = await hardDeleteAllArchived();
    expect(result.deleted).toBe(2);

    expect(await getSessionRecord(archivedKey(a.id))).toBeUndefined();
    expect(await getSessionRecord(archivedKey(b.id))).toBeUndefined();
    const index = await listSessionIndex();
    expect(index.find((e) => e.id === a.id)).toBeUndefined();
    expect(index.find((e) => e.id === b.id)).toBeUndefined();
    expect(index.find((e) => e.id === c.id)).toBeDefined(); // active survives
  });

  it("returns {deleted:0} when there are no archived sessions", async () => {
    await createSession(); // active only
    const result = await hardDeleteAllArchived();
    expect(result.deleted).toBe(0);
  });
});
```

`archiveSession` 已在 `./lifecycle` import 列表中（现有测试用过）。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test src/lib/sessions/lifecycle.test.ts`
Expected: FAIL（`hardDeleteAllArchived` 未定义 / import 报错）。

- [ ] **Step 3: 实现 —— 抽核心 + 重构 + 新函数**

在 `lifecycle.ts`，把 `hardDeleteSession`（行 195-210）替换为「核心 + 薄封装」，并新增 `hardDeleteAllArchived`：

```typescript
/**
 * Hard-delete a set of sessions in ONE atomic batch (their :meta/:agent/:archived
 * keys + index update), then best-effort reclaim each session's output artifacts
 * and scratchpad out-of-band. Shared core for hardDeleteSession (single),
 * hardDeleteExpired (30-day sweep) and hardDeleteAllArchived (manual clear).
 */
export async function hardDeleteSessions(
  ids: string[],
): Promise<{ deleted: number }> {
  if (ids.length === 0) return { deleted: 0 };
  const idSet = new Set(ids);
  const indexRaw = await readIndexRaw();
  const updatedIndex = indexRaw.filter((e) => !idSet.has(e.id));

  const batch: Record<string, unknown> = { [INDEX_KEY]: updatedIndex };
  for (const id of ids) {
    batch[archivedKey(id)] = undefined;
    batch[metaKey(id)] = undefined;
    batch[agentKey(id)] = undefined;
  }
  await writeAtomic(batch);

  for (const id of ids) {
    await deleteSessionArtifacts(id).catch(() => {});
    await deleteScratchpad(id).catch(() => {});
  }
  return { deleted: ids.length };
}

/**
 * Immediately and permanently delete a single session (thin wrapper over
 * hardDeleteSessions).
 */
export async function hardDeleteSession(id: string): Promise<void> {
  await hardDeleteSessions([id]);
}

/**
 * Permanently delete EVERY archived session (the "clear all archived" action).
 * Returns the count deleted.
 */
export async function hardDeleteAllArchived(): Promise<{ deleted: number }> {
  const indexRaw = await readIndexRaw();
  const ids = indexRaw.filter((e) => e.status === "archived").map((e) => e.id);
  return hardDeleteSessions(ids);
}
```

然后把 `hardDeleteExpired`（行 253-275）末尾的「build atomic batch + writeAtomic + scratchpad 清理 loop」替换为复用核心——即把从 `if (toDelete.length === 0) return { deleted: 0 };` 之后的 batch 构建/writeAtomic/scratchpad-loop 整段，改为：

```typescript
  if (toDelete.length === 0) return { deleted: 0 };
  return hardDeleteSessions(toDelete);
```

（保留前面 cutoff 计算与 `toDelete` 收集逻辑不变；删掉原 `updatedIndex`/`batch`/`writeAtomic(batch)`/`for...deleteScratchpad` 那几段。`hardDeleteSessions` 内部会重读 index 并补做 artifacts 清理——对 expired 路径是安全的一致性增强。）

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test src/lib/sessions/lifecycle.test.ts`
Expected: PASS（含既有 hardDeleteSession / hardDeleteExpired 测试不退化）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/sessions/lifecycle.ts src/lib/sessions/lifecycle.test.ts
git commit -m "feat(sessions): hardDeleteAllArchived + shared hardDeleteSessions core (#153)"
```

---

### Task 2: i18n 新增 2 个 key（6 语言）

**Files:**
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts`

- [ ] **Step 1: 在每个字典的 `sessions` 块加 2 个 key**

在 `noArchived` 之后加入（各 locale 用下表，用词与该 locale 既有 `archivedAria` 术语一致）：

en.ts:
```typescript
    deleteAllArchived: "Delete all",
    deleteAllArchivedConfirm: "Permanently delete all {count} archived sessions? This cannot be undone.",
```
zh-CN.ts:
```typescript
    deleteAllArchived: "全部删除",
    deleteAllArchivedConfirm: "永久删除全部 {count} 个已归档会话？此操作无法撤销。",
```
zh-TW.ts:
```typescript
    deleteAllArchived: "全部刪除",
    deleteAllArchivedConfirm: "永久刪除全部 {count} 個已封存的工作階段？此操作無法復原。",
```
es-419.ts:
```typescript
    deleteAllArchived: "Eliminar todas",
    deleteAllArchivedConfirm: "¿Eliminar permanentemente las {count} sesiones archivadas? Esto no se puede deshacer.",
```
ja.ts:
```typescript
    deleteAllArchived: "すべて削除",
    deleteAllArchivedConfirm: "アーカイブ済みセッション {count} 件をすべて完全に削除しますか？この操作は元に戻せません。",
```
pt-BR.ts:
```typescript
    deleteAllArchived: "Excluir todas",
    deleteAllArchivedConfirm: "Excluir permanentemente todas as {count} sessões arquivadas? Isso não pode ser desfeito.",
```

- [ ] **Step 2: 跑 parity 测试确认 PASS**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: PASS（6 语言都加了同样 2 个 key）。

- [ ] **Step 3: 提交**

```bash
git add src/lib/i18n/dictionaries/
git commit -m "i18n: add deleteAllArchived strings for clear-archived action (#153)"
```

---

### Task 3: SessionDrawer「删除全部」按钮

**Files:**
- Modify: `src/sidepanel/components/SessionDrawer.tsx`
- Test: `src/sidepanel/components/SessionDrawer.test.tsx`

**Interfaces:**
- Consumes：`hardDeleteAllArchived`（加进 SessionDrawer 现有 `@/lib/sessions/lifecycle` import，行 31-35）。

- [ ] **Step 1: 写组件测试**

`SessionDrawer.test.tsx`：文件顶部（import 之后）加 module mock + 在末尾追加测试。mock 块（放在所有 import 之后、`describe` 之前）：

```typescript
import * as lifecycle from "@/lib/sessions/lifecycle";

vi.mock("@/lib/sessions/lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sessions/lifecycle")>();
  return { ...actual, hardDeleteAllArchived: vi.fn(async () => ({ deleted: 2 })) };
});
```

末尾追加：

```typescript
describe("SessionDrawer — clear all archived", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("clears all archived after confirm", () => {
    (lifecycle.hardDeleteAllArchived as ReturnType<typeof vi.fn>).mockClear();
    vi.stubGlobal("confirm", vi.fn(() => true));
    const sessions = [
      makeEntry("a1", "archived", "Old A"),
      makeEntry("a2", "archived", "Old B"),
    ];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    fireEvent.click(screen.getByText(/Show Archived/));
    fireEvent.click(screen.getByText("Delete all"));
    expect(lifecycle.hardDeleteAllArchived).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear when confirm is cancelled", () => {
    (lifecycle.hardDeleteAllArchived as ReturnType<typeof vi.fn>).mockClear();
    vi.stubGlobal("confirm", vi.fn(() => false));
    const sessions = [makeEntry("a1", "archived", "Old A")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    fireEvent.click(screen.getByText(/Show Archived/));
    fireEvent.click(screen.getByText("Delete all"));
    expect(lifecycle.hardDeleteAllArchived).not.toHaveBeenCalled();
  });

  it("hides the Delete all button when there are no archived sessions", () => {
    const sessions = [makeEntry("s1", "active", "Active")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    fireEvent.click(screen.getByText(/Show Archived/));
    expect(screen.queryByText("Delete all")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test src/sidepanel/components/SessionDrawer.test.tsx`
Expected: FAIL（无「Delete all」按钮）。

- [ ] **Step 3: 实现**

(a) import：在 `SessionDrawer.tsx` 的 `@/lib/sessions/lifecycle` import（行 31-35）里加 `hardDeleteAllArchived`：
```typescript
import {
  unarchiveSession,
  hardDeleteSession,
  softDeleteSession,
  hardDeleteAllArchived,
} from "@/lib/sessions/lifecycle";
```

(b) handler：在 `handleDeleteForever`（行 248-250）之后加：
```typescript
  async function handleClearAllArchived() {
    if (!window.confirm(t("sessions.deleteAllArchivedConfirm", { count: archivedCount }))) {
      return;
    }
    await hardDeleteAllArchived();
    // store-bus → App useStoreChange("sessions") refreshes the list.
  }
```

(c) 按钮：在 archived 列表 `<div id="archived-session-list">`（行 408-412）内、`<ul>`（行 413）**之前**，插入：
```tsx
            {archivedSessions.length > 0 && (
              <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 16px 4px" }}>
                <button
                  type="button"
                  onClick={handleClearAllArchived}
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    fontWeight: 500,
                    color: "var(--c-danger-fg)",
                    background: "none",
                    border: "1px solid var(--c-danger-line)",
                    borderRadius: 6,
                    padding: "3px 8px",
                    cursor: "pointer",
                  }}
                >
                  {t("sessions.deleteAllArchived")}
                </button>
              </div>
            )}
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test src/sidepanel/components/SessionDrawer.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/SessionDrawer.tsx src/sidepanel/components/SessionDrawer.test.tsx
git commit -m "feat(sidepanel): clear-all-archived button with confirm (#153)"
```

---

### Task 4: 全量验证

- [ ] **Step 1: 全量 test + typecheck + build**

```bash
pnpm test && pnpm typecheck && pnpm build
```
Expected: 全绿（i18n parity 通过；lifecycle 重构旧测试绿；无 unused import）。
