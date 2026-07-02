# 度内反馈（客户端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在扩展设置里加一个反馈输入框（+可选「附带近期日志」勾选框），提交到后端 `POST /feedback`；日志为最近 24h 的 error/warn，**不含聊天数据**。

**Architecture:** 新增 `log-buffer.ts` —— patch `console.error/warn`，把截断后的条目追加到现有 `config` store 的单键 `log_buffer`（复用 `getConfig`/`setConfig`，无需新 IDB store）。`managed-account.ts` 加 `submitFeedback`（可选 Bearer）。`Settings.tsx` 的 `FeedbackSection` 在现有 GitHub/邮件链接之上加表单。

**Tech Stack:** React 19 + TS · vitest + happy-dom + `fake-indexeddb/auto`（`src/test/setup.ts`）· i18n = `src/lib/i18n/dictionaries/*.ts`（6 语言，`dictionary-parity.test.ts` 强制键齐全）。

## Global Constraints

- 后端契约（依赖 `pie-managed-backend` 的 `/feedback`）：`POST ${ACCOUNT_BASE}/feedback`，body `{message, env, logs?}`，可选 `Authorization: Bearer <apiKey>`；成功 `{ok:true}`；失败 `{error}` + 4xx（`invalid_message`/`message_too_long`/`logs_too_large`/`too_many_attempts`）。
- 日志上限（与后端对齐）：每条 `text` 截断 ~500 字、缓冲 ~500 条、保留 24h；发送前把拼装 blob 截到 ≤100000 字。
- 隐私：log-buffer **只 patch `console.error`/`console.warn`**，**从不读 IDB `sessions`（聊天数据）**；`env` 复用现有 `FeedbackEnv`（version/userAgent/providerModel/locale），不含消息正文。
- 提交前后不阻塞、不抛穿：log-buffer 一切 best-effort（内部 try/catch），绝不把异常打回调用方的 `console.error`（否则递归）。
- 现有 `FeedbackSection` 的 GitHub / 邮件外链**保留**。
- 取 managed apiKey 沿用现有模式：`instances.find((i) => i.provider === "managed")?.apiKey`（见 `ManagedErrorCta.tsx:18`）；无则匿名发送。

---

### Task 1: log-buffer 模块（缓冲 + 裁剪 + 序列化）

**Files:**
- Create: `src/lib/log-buffer.ts`
- Test: `src/lib/log-buffer.test.ts`

**Interfaces:**
- Consumes: `getConfig`/`setConfig`（`src/lib/idb/config-store.ts`）。
- Produces:
  - `interface LogEntry { ts: number; level: "error" | "warn"; ctx: string; text: string }`
  - `serialize(args: unknown[]): string`（拼接 + 截断到 500）
  - `appendLog(entry: LogEntry): Promise<void>`（追加 + 裁 24h + 封顶 500，best-effort）
  - `readRecentLogs(now: number, windowMs?: number): Promise<string>`（拼装 oldest→newest 文本 blob）
  - `installLogCapture(ctx: string, now?: () => number): void`（patch console，幂等）

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/log-buffer.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { appendLog, readRecentLogs, serialize } from "./log-buffer";
import { _resetForTests } from "./idb/db";

const H = 60 * 60 * 1000;

describe("log-buffer", () => {
  beforeEach(async () => { await _resetForTests(); });

  it("prunes entries older than 24h", async () => {
    const now = 100 * H;
    await appendLog({ ts: now - 25 * H, level: "warn", ctx: "sw", text: "old" });
    await appendLog({ ts: now, level: "error", ctx: "sw", text: "fresh" });
    const blob = await readRecentLogs(now);
    expect(blob).toContain("fresh");
    expect(blob).not.toContain("old");
  });

  it("caps at 500 entries, dropping oldest", async () => {
    const now = 100 * H;
    for (let i = 0; i < 505; i++) await appendLog({ ts: now, level: "warn", ctx: "sw", text: `e${i}` });
    const lines = (await readRecentLogs(now)).split("\n");
    expect(lines).toHaveLength(500);
    expect(lines[0].endsWith("e5")).toBe(true);
    expect(lines[499].endsWith("e504")).toBe(true);
  });

  it("serialize truncates to 500 chars and stringifies non-strings", () => {
    expect(serialize(["z".repeat(600)]).length).toBe(500);
    expect(serialize([{ a: 1 }, "x"])).toBe('{"a":1} x');
    expect(serialize([new Error("boom")])).toBe("Error: boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test log-buffer`
Expected: FAIL — `Cannot find module './log-buffer'`

- [ ] **Step 3: Write the module**

```ts
// src/lib/log-buffer.ts
//
// Lightweight cross-context error/warn capture for the "attach recent logs"
// feedback option. Patches console.error/warn to append truncated entries to a
// single config-store key. NEVER reads chat data (IDB `sessions`); env/message
// bodies are out of scope by construction.
import { getConfig, setConfig } from "./idb/config-store";

export interface LogEntry {
  ts: number;
  level: "error" | "warn";
  ctx: string;
  text: string;
}

const KEY = "log_buffer";
const MAX_ENTRIES = 500;
const MAX_TEXT = 500;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function serialize(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(" ")
    .slice(0, MAX_TEXT);
}

/** Append one entry; prune >24h; cap to MAX_ENTRIES (drop oldest). Best-effort —
 *  swallows all errors so a failing write never recurses into console.error.
 *  // ponytail: 整缓冲每条全量重写 + last-writer-wins（SW/panel 并发时可能丢个别行），
 *  //           error/warn 量级可接受；热循环狂刷再改增量存储。 */
export async function appendLog(entry: LogEntry): Promise<void> {
  try {
    const cur = (await getConfig<LogEntry[]>(KEY)) ?? [];
    const cutoff = entry.ts - RETENTION_MS;
    const next = [...cur, entry].filter((e) => e.ts >= cutoff);
    if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
    await setConfig(KEY, next);
  } catch {
    /* best-effort */
  }
}

/** Recent entries within `windowMs` (default 24h), oldest→newest, as text. */
export async function readRecentLogs(now: number, windowMs = RETENTION_MS): Promise<string> {
  let cur: LogEntry[] = [];
  try { cur = (await getConfig<LogEntry[]>(KEY)) ?? []; } catch { cur = []; }
  const cutoff = now - windowMs;
  return cur
    .filter((e) => e.ts >= cutoff)
    .map((e) => `[${new Date(e.ts).toISOString()}] ${e.level} (${e.ctx}) ${e.text}`)
    .join("\n");
}

let installed = false;
/** Patch console.error/warn to also append to the buffer. Idempotent per realm. */
export function installLogCapture(ctx: string, now: () => number = () => Date.now()): void {
  if (installed) return;
  installed = true;
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      void appendLog({ ts: now(), level, ctx, text: serialize(args) });
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test log-buffer`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/log-buffer.ts src/lib/log-buffer.test.ts
git commit -m "feat(feedback): log-buffer error/warn capture (config store, 24h ring)"
```

---

### Task 2: 在各上下文入口安装捕获

**Files:**
- Modify: `src/background/index.ts`（SW 入口，import 段之后加一行）
- Modify: `src/sidepanel/main.tsx`（面板入口，`createRoot` 之前加一行）

**Interfaces:**
- Consumes: `installLogCapture`（Task 1）。

- [ ] **Step 1: Install in SW**

`src/background/index.ts`：在 import 段末尾加 `import { installLogCapture } from "@/lib/log-buffer";`，并在模块顶层（import 之后、其余启动代码之前）加：

```ts
installLogCapture("sw");
```

- [ ] **Step 2: Install in side panel**

`src/sidepanel/main.tsx`：import `installLogCapture`，在 `createRoot(...).render(...)` 之前加：

```ts
installLogCapture("panel");
```

- [ ] **Step 3: Verify build**

Run: `pnpm typecheck && pnpm build`
Expected: tsc 0 错；build 成功。

> 无独立单测：安装是 1 行 wiring（patch 全局 console），捕获逻辑已被 Task 1 单测覆盖。

- [ ] **Step 4: Commit**

```bash
git add src/background/index.ts src/sidepanel/main.tsx
git commit -m "feat(feedback): install log capture in sw + panel entrypoints"
```

---

### Task 3: submitFeedback（managed-account.ts）

**Files:**
- Modify: `src/lib/managed-account.ts`（加 `FeedbackError` + `submitFeedback`）
- Test: `src/lib/managed-account.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `ACCOUNT_BASE`（现有）、`FeedbackEnv`（`src/lib/feedback.ts`）、`ManagedAccountDeps`（现有）。
- Produces:
  - `class FeedbackError extends Error { code: string; status: number }`
  - `submitFeedback(input: { message: string; env: FeedbackEnv; logs?: string; apiKey?: string }, deps?: ManagedAccountDeps): Promise<void>`

- [ ] **Step 1: Write the failing test**

追加到 `src/lib/managed-account.test.ts`：

```ts
import { submitFeedback, FeedbackError } from "./managed-account";

describe("submitFeedback", () => {
  const env = { version: "1", userAgent: "UA", providerModel: "managed", locale: "en" };

  it("POSTs /feedback without Bearer when no apiKey", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as unknown as typeof fetch;
    await submitFeedback({ message: "hi", env }, { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", env }),
    });
  });

  it("includes Bearer + logs when provided", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as unknown as typeof fetch;
    await submitFeedback({ message: "hi", env, logs: "boom", apiKey: "sk-v" }, { fetchFn });
    const init = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-v");
    expect(JSON.parse(init.body as string).logs).toBe("boom");
  });

  it("throws FeedbackError with backend code on failure", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: "too_many_attempts" }) })) as unknown as typeof fetch;
    await expect(submitFeedback({ message: "x", env }, { fetchFn })).rejects.toBeInstanceOf(FeedbackError);
    await expect(submitFeedback({ message: "x", env }, { fetchFn })).rejects.toMatchObject({ code: "too_many_attempts", status: 429 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test managed-account`
Expected: FAIL — `submitFeedback` 未导出

- [ ] **Step 3: Implement**

在 `src/lib/managed-account.ts` 顶部 import 加 `import type { FeedbackEnv } from "./feedback";`，文件末尾加：

```ts
/** /feedback 失败：携带后端 error code。 */
export class FeedbackError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = "FeedbackError";
  }
}

/** 提交度内反馈。有 apiKey 则带 Bearer（关联用户），否则匿名。失败抛 FeedbackError。 */
export async function submitFeedback(
  input: { message: string; env: FeedbackEnv; logs?: string; apiKey?: string },
  deps: ManagedAccountDeps = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  const body = JSON.stringify({
    message: input.message,
    env: input.env,
    ...(input.logs ? { logs: input.logs } : {}),
  });
  const resp = await fetchFn(`${ACCOUNT_BASE}/feedback`, { method: "POST", headers, body });
  if (!resp.ok) {
    let code = "feedback_failed";
    try {
      const b = (await resp.json()) as { error?: string };
      if (b && typeof b.error === "string") code = b.error;
    } catch {
      /* 非 JSON 错误体：保留 feedback_failed */
    }
    throw new FeedbackError(code, resp.status);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test managed-account`
Expected: PASS（原有 + 新增 3）

- [ ] **Step 5: Commit**

```bash
git add src/lib/managed-account.ts src/lib/managed-account.test.ts
git commit -m "feat(feedback): submitFeedback client (optional Bearer)"
```

---

### Task 4: Settings 反馈表单 + i18n

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`（重写 `FeedbackSection`；调用点改传 `instances`）
- Modify: `src/lib/i18n/dictionaries/en.ts` 等 **6 个** 词典（加新键）
- Test: `src/sidepanel/components/FeedbackSection.test.tsx`

**Interfaces:**
- Consumes: `submitFeedback`/`FeedbackError`（Task 3）、`readRecentLogs`（Task 1）、现有 `FeedbackEnv`/`buildGithubNewIssueUrl`/`buildFeedbackMailto`、`useT`、`getLocale`。
- 需导出 `FeedbackSection` 供测试。

- [ ] **Step 1: Add i18n keys (6 dictionaries)**

在每个 `src/lib/i18n/dictionaries/*.ts` 的 `settings.feedback` 段加以下键（英文值如下；其余 5 语按现有风格翻译，`dictionary-parity.test.ts` 会强制键齐全）：

```
"settings.feedback.formHint": "Send feedback straight from here — just type and send.",
"settings.feedback.placeholder": "What's on your mind?",
"settings.feedback.includeLogs": "Attach recent logs to help diagnose (last 24h, no chat data)",
"settings.feedback.send": "Send",
"settings.feedback.sending": "Sending…",
"settings.feedback.sent": "Thanks! Feedback sent.",
"settings.feedback.sendError": "Couldn't send. Please try again.",
"settings.feedback.orLabel": "or",
```

- [ ] **Step 2: Write the failing test**

```tsx
// src/sidepanel/components/FeedbackSection.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeedbackSection } from "./Settings";

const submitFeedback = vi.fn(async () => {});
vi.mock("../../lib/managed-account", async (orig) => ({
  ...(await orig<typeof import("../../lib/managed-account")>()),
  submitFeedback: (...a: unknown[]) => submitFeedback(...a),
}));
const readRecentLogs = vi.fn(async () => "recent-log-blob");
vi.mock("../../lib/log-buffer", () => ({ readRecentLogs: (...a: unknown[]) => readRecentLogs(...a) }));

beforeEach(() => {
  submitFeedback.mockClear();
  readRecentLogs.mockClear();
  (globalThis as unknown as { chrome: { runtime: { getManifest: () => { version: string } } } }).chrome.runtime.getManifest = () => ({ version: "9.9.9" });
});

describe("FeedbackSection", () => {
  it("sends trimmed message, no logs when unchecked, with managed apiKey", async () => {
    const managed = { provider: "managed", apiKey: "sk-v" } as never;
    render(<FeedbackSection instances={[managed]} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  hello  " } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
    const [input] = submitFeedback.mock.calls[0];
    expect(input).toMatchObject({ message: "hello", apiKey: "sk-v" });
    expect(input.logs).toBeUndefined();
    expect(readRecentLogs).not.toHaveBeenCalled();
    expect(await screen.findByText("Thanks! Feedback sent.")).toBeInTheDocument();
  });

  it("attaches logs when checkbox ticked; anonymous when no managed instance", async () => {
    render(<FeedbackSection instances={[{ provider: "openai", apiKey: "byok" } as never]} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "bug" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
    const [input] = submitFeedback.mock.calls[0];
    expect(input.logs).toBe("recent-log-blob");
    expect(input.apiKey).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test FeedbackSection`
Expected: FAIL — `FeedbackSection` 未导出 / 表单元素不存在

- [ ] **Step 4: Rewrite FeedbackSection + change call site**

在 `src/sidepanel/components/Settings.tsx`：

1. import 加：
```ts
import { submitFeedback, FeedbackError } from "../../lib/managed-account";
import { readRecentLogs } from "../../lib/log-buffer";
import { useState } from "react"; // 若文件已从 "react" 导入，合并即可
```

2. 调用点（`tab === "general"` 分支）把 `<FeedbackSection activeInstance={instances[0]} />` 改为 `<FeedbackSection instances={instances} />`。

3. 用下面这版替换 `FeedbackSection`（`export` 出来供测试）：

```tsx
const MAX_LOG_BLOB = 100_000;

export function FeedbackSection({ instances }: { instances: DecryptedInstance[] }) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [includeLogs, setIncludeLogs] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const active = instances[0];
  const env: FeedbackEnv = {
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    providerModel: active ? active.provider : "(no config)",
    locale: getLocale(),
  };
  const managedApiKey = instances.find((i) => i.provider === "managed")?.apiKey;

  async function onSend() {
    const trimmed = message.trim();
    if (!trimmed || status === "sending") return;
    setStatus("sending");
    try {
      const logs = includeLogs ? (await readRecentLogs(Date.now())).slice(0, MAX_LOG_BLOB) : undefined;
      await submitFeedback({ message: trimmed, env, ...(logs ? { logs } : {}), ...(managedApiKey ? { apiKey: managedApiKey } : {}) });
      setMessage("");
      setIncludeLogs(false);
      setStatus("sent");
    } catch (e) {
      // FeedbackError 携带后端 code；此处只需给用户一个统一的「重试」提示
      void (e instanceof FeedbackError);
      setStatus("error");
    }
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">{t("settings.feedback.sectionTitle")}</div>
      <p className="text-[12px] leading-[18px] text-fg-2">{t("settings.feedback.formHint")}</p>
      <textarea
        value={message}
        onChange={(e) => { setMessage(e.target.value); if (status !== "idle") setStatus("idle"); }}
        placeholder={t("settings.feedback.placeholder")}
        rows={3}
        className="w-full resize-y rounded-control border border-line bg-field px-2.5 py-2 text-[13px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
      />
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <input type="checkbox" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} />
        {t("settings.feedback.includeLogs")}
      </label>
      <div className="flex items-center gap-3 pt-0.5">
        <button
          onClick={onSend}
          disabled={!message.trim() || status === "sending"}
          className="rounded-control bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {status === "sending" ? t("settings.feedback.sending") : t("settings.feedback.send")}
        </button>
        {status === "sent" && <span className="text-[12px] text-success">{t("settings.feedback.sent")}</span>}
        {status === "error" && <span className="text-[12px] text-warning">{t("settings.feedback.sendError")}</span>}
      </div>
      <p className="pt-1 text-[12px] leading-[18px] text-fg-2">{t("settings.feedback.githubHint")}</p>
      <div className="flex items-center gap-4 pt-0.5">
        <a href={buildGithubNewIssueUrl(env)} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-accent hover:underline">{t("settings.feedback.githubButton")} ↗</a>
        <a href={buildFeedbackMailto(env)} className="text-[13px] text-fg-2 hover:text-fg-1">{t("settings.feedback.emailButton")} ↗</a>
      </div>
    </section>
  );
}
```

> 若 `text-success` / `text-warning` / `rounded-control` / `bg-accent` 等类名与现有主题不符，按 Settings.tsx 内已用的等价类调整（如 warning 用 `text-warning`、成功用现有 accent/positive 类）。这些是纯样式，不影响逻辑与测试。

- [ ] **Step 5: Run tests + typecheck + build**

Run: `pnpm test FeedbackSection managed-account log-buffer && pnpm test dictionary-parity && pnpm typecheck && pnpm build`
Expected: 全 PASS；parity 测试确认 6 词典新键齐全；tsc 0 错。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/Settings.tsx src/sidepanel/components/FeedbackSection.test.tsx src/lib/i18n/dictionaries
git commit -m "feat(feedback): in-app feedback form with optional recent logs"
```

---

## Self-Review

- **Spec 覆盖**：log-buffer 采集（T1）· 入口安装（T2）· submitFeedback（T3）· 表单+勾选+日志附带+i18n（T4）——覆盖 spec 客户端全部条目。后端表/端点/admin 在**后端计划**里。
- **占位扫描**：无 TBD；每步含真实代码/命令/期望输出。样式类名的兜底说明是纯 CSS 提示、不含逻辑占位。
- **类型一致**：`LogEntry`/`readRecentLogs`/`serialize`（T1）在 T4 引用一致；`submitFeedback` 入参 `{message, env, logs?, apiKey?}`（T3）与 T4 调用一致；`FeedbackEnv` 复用现有 `src/lib/feedback.ts` 定义；managed apiKey 取法 `instances.find(i => i.provider === "managed")?.apiKey` 与 spec/现有代码一致。
- **隐私核对**：日志源仅 console.error/warn，`readRecentLogs` 只读 `config` store 的 `log_buffer` 键，绝不触碰 `sessions`；`env` 无消息正文。
