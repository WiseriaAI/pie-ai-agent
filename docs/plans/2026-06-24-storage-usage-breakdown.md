# 存储用量 per-session 明细面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击会话抽屉底部的存储条 → 展开 per-session 字节占用明细（按会话、降序）。issue #153 切片①。

**Architecture:** 新增一个 storage 数据 API（一次 getAll 按 sid 分桶）；把 `SessionDrawer` 内联的 `StorageIndicator` 抽到独立文件并扩展为可展开面板。复用 `Collapse` / `useStoreChange` / `humanSize` / `useT`。无新 i18n key。

**Tech Stack:** React 19 + TS、vitest + happy-dom + @testing-library/react。

## Global Constraints

- 不加新 i18n key（toggle 复用 `t("sessions.storage")`，行用 `t("sessions.untitled")`，字节走 `humanSize`）——避开 6 语言字典 parity 改动。
- bytes 是 `JSON.stringify(rec).length` 估算（非精确磁盘字节）；**一次** `getAll` 覆盖所有会话，不per-session多次读。
- 样式沿用既有 token（`--c-fg-1/2/3`、`--c-line`、`'JetBrains Mono'` 10px 标签）。
- 提交前：`pnpm test`、`pnpm typecheck`、`pnpm build` 全绿。

---

### Task 1: 数据 API `listSessionsWithBytes`

**Files:**
- Modify: `src/lib/sessions/storage.ts`（新增 type + 函数；放在 `getTotalBytes` 之后）
- Test: `src/lib/sessions/storage.test.ts`

**Interfaces:**
- Consumes（已在文件内/已 import）：`tx`、`STORES`（`@/lib/idb/db`，已 import 于 storage.ts:17）、`listSessionIndex()`、`SessionStatus`（来自 `./types`，确认已 import；若未则补 `import type { SessionStatus } from "./types"`）。
- Produces：`interface SessionByteEntry { id: string; title?: string; status: SessionStatus; bytes: number }`、`listSessionsWithBytes(): Promise<SessionByteEntry[]>`。

- [ ] **Step 1: 写失败测试**

在 `storage.test.ts` 末尾追加（`putSessionRecord` / `agentKey` / `createSession` / `listSessionsWithBytes` 需在顶部 import 列表里——`putSessionRecord` 已从 `@/lib/idb/sessions-store` 导入；`agentKey` 已从 `./storage` 导入；把 `listSessionsWithBytes` 加进 `./storage` 的 import 列表）：

```typescript
describe("listSessionsWithBytes", () => {
  it("attributes bytes per session, sorted descending, with title/status", async () => {
    const a = await createSession();
    const b = await createSession();
    // Make session A much bigger by writing a large agent record.
    await putSessionRecord(agentKey(a.id), { messages: "x".repeat(5000) });

    const list = await listSessionsWithBytes();
    const ids = list.map((e) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    const ai = ids.indexOf(a.id);
    const bi = ids.indexOf(b.id);
    expect(ai).toBeLessThan(bi); // bigger session sorts first
    expect(list[ai]!.bytes).toBeGreaterThan(list[bi]!.bytes);
    expect(list[ai]!.bytes).toBeGreaterThan(5000);
    expect(typeof list[ai]!.status).toBe("string");
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test src/lib/sessions/storage.test.ts`
Expected: FAIL（`listSessionsWithBytes` 未定义 / import 报错）。

- [ ] **Step 3: 实现**

在 `storage.ts` 的 `getTotalBytes`/`getStoresByteLength` 之后追加。先确认顶部有 `import type { SessionStatus } from "./types";`（types 文件已有 `SessionStatus`；若 storage.ts 尚未导入则加入 type import）：

```typescript
export interface SessionByteEntry {
  id: string;
  title?: string;
  status: SessionStatus;
  bytes: number;
}

/**
 * Per-session storage attribution. ONE getAll over the sessions store, bucketed
 * by session id (the :meta / :agent / :archived records of one session), joined
 * with the session index for title/status, sorted by bytes descending. `bytes`
 * is a JSON.stringify estimate — the :agent record (raw message history)
 * dominates — not a precise on-disk figure. Archived sessions are included
 * (listSessionIndex does not filter by status).
 */
export async function listSessionsWithBytes(): Promise<SessionByteEntry[]> {
  const [index, all] = await Promise.all([
    listSessionIndex(),
    tx<Array<{ id: string; value: unknown }>>(
      STORES.sessions,
      "readonly",
      (s) => s.getAll(),
    ),
  ]);
  const byteMap = new Map<string, number>();
  for (const rec of all) {
    const sid = rec.id.replace(/:(meta|agent|archived)$/, "");
    byteMap.set(sid, (byteMap.get(sid) ?? 0) + JSON.stringify(rec).length);
  }
  return index
    .map((e) => ({ id: e.id, title: e.title, status: e.status, bytes: byteMap.get(e.id) ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes);
}
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test src/lib/sessions/storage.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/sessions/storage.ts src/lib/sessions/storage.test.ts
git commit -m "feat(sessions): listSessionsWithBytes — per-session storage attribution (#153)"
```

---

### Task 2: 抽出并扩展 StorageIndicator（可展开明细面板）

**Files:**
- Create: `src/sidepanel/components/StorageIndicator.tsx`
- Modify: `src/sidepanel/components/SessionDrawer.tsx`（删局部 StorageIndicator，改 import）
- Test: `src/sidepanel/components/StorageIndicator.test.tsx`

**Interfaces:**
- Consumes：`getTotalBytes` / `listSessionsWithBytes`（`@/lib/sessions/storage`）、`humanSize`（`@/lib/files/mime-label`）、`Collapse`（`./ui/Collapse`）、`useStoreChange`（`@/sidepanel/hooks/useStoreChange`）、`useT`（`@/lib/i18n`）。
- Produces：`export function StorageIndicator()`。

- [ ] **Step 1: 写组件测试（先建文件）**

`src/sidepanel/components/StorageIndicator.test.tsx`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/sessions/storage", () => ({
  getTotalBytes: vi.fn(async () => 2 * 1024 * 1024),
  listSessionsWithBytes: vi.fn(async () => [
    { id: "s1", title: "Big chat", status: "active", bytes: 5000 },
    { id: "s2", title: "Small chat", status: "paused", bytes: 100 },
  ]),
}));

import { StorageIndicator } from "./StorageIndicator";

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe("<StorageIndicator />", () => {
  it("shows total usage and stays collapsed initially", async () => {
    render(<StorageIndicator />);
    await waitFor(() => expect(screen.getByText("2.0 MB")).toBeTruthy());
    expect(screen.queryByText("Big chat")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the per-session breakdown on click", async () => {
    render(<StorageIndicator />);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Big chat")).toBeTruthy();
    expect(screen.getByText("Small chat")).toBeTruthy();
    // bigger session row shows its size
    expect(screen.getByText("4.9 KB")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test src/sidepanel/components/StorageIndicator.test.tsx`
Expected: FAIL（`./StorageIndicator` 模块不存在）。

- [ ] **Step 3: 实现组件**

新建 `src/sidepanel/components/StorageIndicator.tsx`：

```tsx
import { useCallback, useEffect, useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { getTotalBytes, listSessionsWithBytes, type SessionByteEntry } from "@/lib/sessions/storage";
import { humanSize } from "@/lib/files/mime-label";
import { useStoreChange } from "@/sidepanel/hooks/useStoreChange";
import { Collapse } from "./ui/Collapse";

const MONO = "'JetBrains Mono', monospace";

export function StorageIndicator() {
  const t = useT();
  const listId = useId();
  const [usedBytes, setUsedBytes] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<SessionByteEntry[]>([]);

  const loadTotal = useCallback(async () => { setUsedBytes(await getTotalBytes()); }, []);
  const loadRows = useCallback(async () => { setRows(await listSessionsWithBytes()); }, []);

  useEffect(() => { void loadTotal(); }, [loadTotal]);
  useEffect(() => { if (expanded) void loadRows(); }, [expanded, loadRows]);

  const refresh = useCallback(() => {
    void loadTotal();
    if (expanded) void loadRows();
  }, [loadTotal, loadRows, expanded]);
  useStoreChange("sessions", refresh);
  useStoreChange("config", () => { void loadTotal(); });
  useStoreChange("instances", () => { void loadTotal(); });

  const usedMB = usedBytes / (1024 * 1024);

  return (
    <div style={{ marginTop: "auto", padding: "14px 16px", borderTop: "1px solid var(--c-line)" }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "none", border: "none", padding: 0, cursor: "pointer",
        }}
      >
        <span
          style={{
            flex: 1, textAlign: "left", fontFamily: MONO, fontSize: 10, fontWeight: 500,
            color: "var(--c-fg-3)", letterSpacing: "0.12em", textTransform: "uppercase",
          }}
        >
          {t("sessions.storage")}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, color: "var(--c-fg-2)" }}>
          {usedMB.toFixed(1)} MB
        </span>
        <svg
          width="9" height="9" viewBox="0 0 12 12" aria-hidden="true"
          style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 150ms", color: "var(--c-fg-3)" }}
        >
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <Collapse open={expanded}>
        <ul
          id={listId}
          role="list"
          style={{ listStyle: "none", margin: "8px 0 0", padding: 0, maxHeight: 240, overflowY: "auto" }}
        >
          {rows.map((r) => (
            <li
              key={r.id}
              role="listitem"
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
                borderTop: "1px solid var(--c-line)",
              }}
            >
              <span
                style={{
                  flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap", fontSize: 12, color: "var(--c-fg-1)",
                }}
              >
                {r.title ?? t("sessions.untitled")}
              </span>
              <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 10, color: "var(--c-fg-3)" }}>
                {humanSize(r.bytes)}
              </span>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}
```

- [ ] **Step 4: 改 SessionDrawer 用新组件**

在 `SessionDrawer.tsx`：删除局部 `StorageIndicator` 函数定义（约 line 50-91，含 `// ── StorageIndicator ──` 注释块）；在 import 区加 `import { StorageIndicator } from "./StorageIndicator";`；移除现在 unused 的 `getTotalBytes` import（若 SessionDrawer 不再直接用它——确认后删，typecheck 会报 unused）。JSX 中 `<StorageIndicator />` 的使用点不变。

- [ ] **Step 5: 跑测试确认 PASS**

Run: `pnpm test src/sidepanel/components/StorageIndicator.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/sidepanel/components/StorageIndicator.tsx src/sidepanel/components/StorageIndicator.test.tsx src/sidepanel/components/SessionDrawer.tsx
git commit -m "feat(sidepanel): expandable storage breakdown by session (#153)"
```

---

### Task 3: 全量验证

- [ ] **Step 1: 全量 test + typecheck + build**

```bash
pnpm test && pnpm typecheck && pnpm build
```
Expected: 全绿（i18n parity 不破——无新 key；SessionDrawer 无 unused import）。若 typecheck 报 SessionDrawer 未用的 `getTotalBytes`/`useCallback`/`useEffect`/`useState` import，按报错删除对应未用项。
