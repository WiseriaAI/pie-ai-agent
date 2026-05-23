# 任务内 react 段 LLM compaction 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 长任务超过 provider token 阈值时,把最旧的 react 步骤经 LLM 摘要成「合成对」in-place 写进 `ctx.history` 并持久化,替代当前的固定 12 对硬丢,保住早期关键发现。

**Architecture:** 新增独立模块 `compact-react-window.ts`,核心 `compactReactWindow` 是注入式纯逻辑(摘要器可 mock),in-place 重写 `history` 数组;触发判定用 provider-aware token 阈值(elide 后等效大小),保鲜区 `KEEP_RECENT` 对永不压,合成对 append-only 累积。主循环 `loop.ts` 在 wire-time 整形之前调用它,`onStepSnapshot` 自然持久化压缩版。side panel 历史(`meta.messages`)独立存储,不受影响。

**Tech Stack:** TypeScript, vitest, 现有 `model-router` streamChat / `window-token-budget` estimateTokens / `untrusted-wrappers` escape。

**Spec:** `docs/specs/2026-05-22-task-internal-compaction.md`

---

## Task 1: 新增 wrapper tag `untrusted_compacted_steps`

合成对的 user 摘要要包在 `<untrusted_compacted_steps>` 里。该 tag 必须同时登记进 `UNTRUSTED_WRAPPER_TAGS` 数组**和** `snapshot.ts` 的 `sanitizeText` replace 链(dual-list lock-step,由 `untrusted-wrappers.test.ts` 的 fs-read 检查强制)。

**Files:**
- Modify: `src/lib/agent/untrusted-wrappers.ts:41-51`
- Modify: `src/lib/dom-actions/snapshot.ts:28-37`
- Test: `src/lib/agent/untrusted-wrappers.test.ts`(已有 lock-step 检查,自动覆盖新 tag)

- [ ] **Step 1: 数组加 tag,先制造 lock-step 失败**

在 `untrusted-wrappers.ts` 的 `UNTRUSTED_WRAPPER_TAGS` 末尾(`"untrusted_skill_content",` 之后)加一行:

```typescript
  "untrusted_skill_content",
  "untrusted_compacted_steps",
] as const;
```

- [ ] **Step 2: 跑 lock-step 测试,验证它失败**

Run: `pnpm test src/lib/agent/untrusted-wrappers.test.ts`
Expected: FAIL — "snapshot.ts is missing .replace(/<\/?untrusted_compacted_steps>/gi, "[filtered]") — dual-list lock-step broken"

- [ ] **Step 3: snapshot.ts 补上对应 replace**

在 `snapshot.ts` 的 `sanitizeText` replace 链末尾(`untrusted_skill_content` 那行之后)加:

```typescript
      .replace(/<\/?untrusted_skill_content>/gi, "[filtered]")
      .replace(/<\/?untrusted_compacted_steps>/gi, "[filtered]");
```

注意:原最后一行以 `;` 结尾,现把 `;` 移到新增行末。

- [ ] **Step 4: 跑测试,验证通过**

Run: `pnpm test src/lib/agent/untrusted-wrappers.test.ts`
Expected: PASS（lock-step + 全部 escape 测试,新 tag 被 `escapes ASCII closing tag for all known wrapper tags` 自动覆盖）

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/untrusted-wrappers.ts src/lib/dom-actions/snapshot.ts
git commit -m "feat(agent): 新增 untrusted_compacted_steps wrapper tag (#58)"
```

---

## Task 2: `compact-react-window.ts` 核心逻辑(注入式,纯逻辑可测)

`compactReactWindow(history, maxContextTokens, summarizer, signal)` in-place 改 `history`。摘要器注入,单测用 mock。分三个 TDD 循环:fast path / 触发+合成对+保鲜区+append-only / null+abort+交替。

**Files:**
- Create: `src/lib/agent/compact-react-window.ts`
- Test: `src/lib/agent/compact-react-window.test.ts`

### 循环 A — fast path + 模块骨架

- [ ] **Step 1: 写失败测试(fast path)**

创建 `src/lib/agent/compact-react-window.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import { compactReactWindow, type ReactSummarizer } from "./compact-react-window";

// ── helpers ─────────────────────────────────────────────────────────────────
function toolUsePair(name: string, big: string): AgentMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id: name, name, input: { data: big } } as ContentBlock] },
    { role: "user", content: [{ type: "tool_result", toolUseId: name, content: big } as ContentBlock] },
  ];
}
function baseHistory(pairs: number, bigLen = 100): AgentMessage[] {
  const h: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
  ];
  for (let i = 0; i < pairs; i++) h.push(...toolUsePair(`t${i}`, "y".repeat(bigLen)));
  return h;
}
const okSummarizer: ReactSummarizer = vi.fn(async () => "动作: t0 → t1\n发现: 关键数据 42");
const abortSignal = () => new AbortController().signal;

describe("compactReactWindow — fast path", () => {
  it("不超阈值时 history 不变", async () => {
    const h = baseHistory(6);
    const before = structuredClone(h);
    await compactReactWindow(h, 1_000_000, okSummarizer, abortSignal());
    expect(h).toEqual(before);
  });
});
```

- [ ] **Step 2: 跑测试,验证失败(模块不存在)**

Run: `pnpm test src/lib/agent/compact-react-window.test.ts`
Expected: FAIL — Cannot find module './compact-react-window' / `compactReactWindow is not a function`

- [ ] **Step 3: 写骨架 + fast path**

创建 `src/lib/agent/compact-react-window.ts`:

```typescript
/**
 * #58 子点 b — 任务内 react 段 LLM compaction。
 *
 * compactReactWindow 是有状态的 IN-PLACE 重写:超 token 阈值时把最旧的
 * react 步骤经注入的 summarizer 摘成一个「合成对」(assistant 占位 + user
 * untrusted 摘要),splice 替换进 history 数组本身。合成对 append-only 累积,
 * 持久化由调用方的 onStepSnapshot(structuredClone(history))承担。
 *
 * 与 elide/budget(无状态 wire-time 副本)不同:compaction 含 LLM 调用,
 * 每轮重算会贵且非确定,故 in-place 持久化、压一次缓存住。
 */
import type { AgentMessage, ContentBlock } from "../model-router/types";
import { findReactStartIdx } from "./window";
import { estimateTokens } from "./window-token-budget";
import { elideStaleObservations } from "./elide-stale-observations";
import { escapeUntrustedWrappers } from "./untrusted-wrappers";

/** 注入式摘要器:输入待压缩的步骤对,返回 untrusted 摘要正文;null = 失败/abort/空。 */
export type ReactSummarizer = (
  pairs: AgentMessage[],
  signal: AbortSignal,
) => Promise<string | null>;

/** 保鲜区下限:最近 KEEP_RECENT 对原始步骤永不压缩。 */
const KEEP_RECENT = 4;
/** 触发阈值比例,复用 applyTokenBudget 的 80%。 */
const THRESHOLD_RATIO = 0.8;
/** 合成对 user 那条携带的标记 tag,用于识别已压缩区。 */
const COMPACTED_TAG = "untrusted_compacted_steps";

/** user message 是否为合成对的摘要条(含 COMPACTED_TAG)。 */
function isCompactedUserMsg(msg: AgentMessage): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return (msg.content as ContentBlock[]).some(
    (b) => b.type === "text" && b.text.includes(`<${COMPACTED_TAG}>`),
  );
}

export async function compactReactWindow(
  history: AgentMessage[],
  maxContextTokens: number,
  summarizer: ReactSummarizer,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const threshold = maxContextTokens * THRESHOLD_RATIO;
  // 用 elide 后的等效大小判定,与最终实际发送量一致。
  if (estimateTokens(elideStaleObservations(history)) <= threshold) return;
  // 触发逻辑在循环 B 实现。
}
```

- [ ] **Step 4: 跑测试,验证通过**

Run: `pnpm test src/lib/agent/compact-react-window.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/compact-react-window.ts src/lib/agent/compact-react-window.test.ts
git commit -m "feat(agent): compact-react-window 骨架 + fast path (#58)"
```

### 循环 B — 触发 + 合成对 + 保鲜区 + append-only

- [ ] **Step 1: 追加失败测试**

在 `compact-react-window.test.ts` 末尾追加:

```typescript
function compactedPair(): AgentMessage[] {
  return [
    { role: "assistant", content: [{ type: "text", text: "[早期 N 步已压缩为摘要]" }] },
    { role: "user", content: [{ type: "text", text: `<${"untrusted_compacted_steps"}>\n动作: 旧\n发现: 旧\n</${"untrusted_compacted_steps"}>` }] },
  ];
}

describe("compactReactWindow — 触发压缩", () => {
  it("超阈值:最旧可压对被替换为合成对,保鲜区保留", async () => {
    // 6 对,每对约 200+ chars;maxCtx=300 → threshold 240,远超 → 触发。
    const h = baseHistory(6, 100);
    const summarizer = vi.fn<ReactSummarizer>(async () => "动作: t0 → t1\n发现: 价格 42");
    await compactReactWindow(h, 300, summarizer, new AbortController().signal);

    // summarizer 被调用一次,参数是最旧的若干原始对(均为原始 tool_use/tool_result)。
    expect(summarizer).toHaveBeenCalledTimes(1);
    const victim = summarizer.mock.calls[0][0];
    expect(victim.length % 2).toBe(0);
    expect((victim[0].content as ContentBlock[])[0].type).toBe("tool_use");

    // history 中出现合成对:assistant 占位(ContentBlock[] text) + user 含 tag。
    const synthUser = h.find((m) => isCompactedUserMsgExported(m));
    expect(synthUser).toBeDefined();
    const synthIdx = h.indexOf(synthUser!);
    expect(h[synthIdx - 1].role).toBe("assistant");
    expect(Array.isArray(h[synthIdx - 1].content)).toBe(true);

    // 保鲜区:最近 4 对原始(t2..t5)仍在,未被压。
    const text = JSON.stringify(h);
    expect(text).toContain("t5");
    expect(text).toContain("t2");
    // 摘要正文经 escape 后出现。
    expect(text).toContain("价格 42");
  });

  it("append-only:已有合成对不重压,新对追加其后", async () => {
    const h: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...compactedPair(),       // 已压缩区(1 个合成对)
    ];
    for (let i = 0; i < 6; i++) h.push(...toolUsePair(`t${i}`, "y".repeat(100)));

    const summarizer = vi.fn<ReactSummarizer>(async () => "动作: 新\n发现: 新数据");
    await compactReactWindow(h, 300, summarizer, new AbortController().signal);

    // 旧合成对(发现: 旧)仍在,且在新合成对(发现: 新数据)之前。
    const s = JSON.stringify(h);
    expect(s).toContain("发现: 旧");
    expect(s).toContain("发现: 新数据");
    expect(s.indexOf("发现: 旧")).toBeLessThan(s.indexOf("发现: 新数据"));
    // victim 只含原始对,不含旧合成对(summarizer 没收到旧摘要)。
    const victim = JSON.stringify(summarizer.mock.calls[0][0]);
    expect(victim).not.toContain("发现: 旧");
  });
});
```

并在测试文件顶部 import 区补一个导出供断言用(见 Step 3 会导出 `isCompactedUserMsg`):

```typescript
import { compactReactWindow, isCompactedUserMsg as isCompactedUserMsgExported, type ReactSummarizer } from "./compact-react-window";
```

(替换循环 A Step 1 写的那行 import。)

- [ ] **Step 2: 跑测试,验证失败**

Run: `pnpm test src/lib/agent/compact-react-window.test.ts`
Expected: FAIL — `isCompactedUserMsg` 未导出 / 触发分支未实现,合成对不出现

- [ ] **Step 3: 实现触发 + 合成对替换**

把 `isCompactedUserMsg` 改为 `export`,并补全 `compactReactWindow` 阈值判定之后的逻辑(替换 `// 触发逻辑在循环 B 实现。`):

```typescript
  const reactStartIdx = findReactStartIdx(history);
  if (reactStartIdx === -1) return;

  // react 段按 2 条一对(交替不变式保证;尾部奇数条不参与)。
  const reactLen = history.length - reactStartIdx;
  const pairCount = Math.floor(reactLen / 2);
  if (pairCount === 0) return;

  // 已压缩区:开头连续的合成对(user 含 tag)。
  let compactedCount = 0;
  while (
    compactedCount < pairCount &&
    isCompactedUserMsg(history[reactStartIdx + compactedCount * 2 + 1])
  ) {
    compactedCount++;
  }

  // 可压原始对数 = 总对 - 已压缩 - 保鲜。
  const maxCompactable = pairCount - compactedCount - KEEP_RECENT;
  if (maxCompactable <= 0) return;

  const victimStart = reactStartIdx + compactedCount * 2;

  // 逐对累积 victim,直到「移除后」elide 估算达标,或可压对耗尽。
  let victimPairs = 0;
  while (victimPairs < maxCompactable) {
    victimPairs++;
    const candidate = [
      ...history.slice(0, victimStart),
      ...history.slice(victimStart + victimPairs * 2),
    ];
    if (estimateTokens(elideStaleObservations(candidate)) <= threshold) break;
  }

  const victimMsgs = history.slice(victimStart, victimStart + victimPairs * 2);
  const summary = await summarizer(victimMsgs, signal);
  if (signal.aborted || summary === null) return; // 本步跳过,history 不变

  const synthetic = buildSyntheticPair(summary, victimPairs);
  history.splice(victimStart, victimPairs * 2, ...synthetic);
}

/** 构造一个合成对:可信 assistant 占位 + untrusted user 摘要(含 tag、已 escape)。 */
function buildSyntheticPair(summary: string, pairs: number): AgentMessage[] {
  const safe = escapeUntrustedWrappers(summary);
  return [
    {
      role: "assistant",
      content: [{ type: "text", text: `[早期 ${pairs} 对步骤已压缩为摘要]` }],
    },
    {
      role: "user",
      content: [{ type: "text", text: `<${COMPACTED_TAG}>\n${safe}\n</${COMPACTED_TAG}>` }],
    },
  ];
}
```

- [ ] **Step 4: 跑测试,验证通过**

Run: `pnpm test src/lib/agent/compact-react-window.test.ts`
Expected: PASS（fast path + 触发 + append-only 三组）

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/compact-react-window.ts src/lib/agent/compact-react-window.test.ts
git commit -m "feat(agent): compactReactWindow 触发/合成对/append-only (#58)"
```

### 循环 C — null 跳过 + abort + 交替不变式

- [ ] **Step 1: 追加失败测试**

在 `compact-react-window.test.ts` 末尾追加:

```typescript
function noAdjacentSameRole(h: AgentMessage[]): boolean {
  for (let i = 1; i < h.length; i++) {
    if (h[i].role === h[i - 1].role && h[i].role !== "system") return false;
  }
  return true;
}

describe("compactReactWindow — 边界", () => {
  it("summarizer 返回 null → history 不变", async () => {
    const h = baseHistory(6, 100);
    const before = structuredClone(h);
    const summarizer = vi.fn<ReactSummarizer>(async () => null);
    await compactReactWindow(h, 300, summarizer, new AbortController().signal);
    expect(h).toEqual(before);
  });

  it("signal.aborted → history 不变(即使超阈值)", async () => {
    const h = baseHistory(6, 100);
    const before = structuredClone(h);
    const ac = new AbortController();
    ac.abort();
    await compactReactWindow(h, 300, vi.fn(async () => "x"), ac.signal);
    expect(h).toEqual(before);
  });

  it("压缩后维持 user/assistant 严格交替", async () => {
    const h = baseHistory(6, 100);
    await compactReactWindow(h, 300, vi.fn<ReactSummarizer>(async () => "动作: a\n发现: b"), new AbortController().signal);
    expect(noAdjacentSameRole(h)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试,验证状态**

Run: `pnpm test src/lib/agent/compact-react-window.test.ts`
Expected: PASS（循环 B 的实现已天然满足这三条:null/abort 早返回、合成对成对插入维持交替)。若 abort 测试失败,确认 `compactReactWindow` 首行 `if (signal.aborted) return;` 存在。

> 说明:这一循环主要是固化边界契约的回归测试。若 Step 2 直接 PASS(无需改实现),这是预期的——这些行为在循环 B 已实现,本循环把它们钉成显式测试,防未来回归。

- [ ] **Step 3: Commit**

```bash
git add src/lib/agent/compact-react-window.test.ts
git commit -m "test(agent): compactReactWindow null/abort/交替 回归 (#58)"
```

---

## Task 3: 默认 summarizer(prompt 构造纯函数 + streamChat wrapper)

`compactReactWindow` 注入 summarizer。本任务提供默认实现:`buildCompactionMessages`(纯函数,单测)把待压步骤拼成一条 user prompt;`createDefaultSummarizer` 用当前 model 跑无 tool streamChat 收集文本(薄 wrapper,靠类型 + build,模式同 `generateStuckSummary`)。

**Files:**
- Modify: `src/lib/agent/compact-react-window.ts`
- Test: `src/lib/agent/compact-react-window.test.ts`

- [ ] **Step 1: 写失败测试(buildCompactionMessages)**

在测试文件末尾追加,并把顶部 import 改为:

```typescript
import { compactReactWindow, isCompactedUserMsg as isCompactedUserMsgExported, buildCompactionMessages, type ReactSummarizer } from "./compact-react-window";
```

追加测试:

```typescript
describe("buildCompactionMessages", () => {
  it("生成 system + 单条 user prompt,user 含动作名与结果文本", () => {
    const pairs = toolUsePair("navigate", "FOUND_PRICE_42");
    const msgs = buildCompactionMessages(pairs);
    expect(msgs[0].role).toBe("system");
    expect(msgs[msgs.length - 1].role).toBe("user");
    // 只有 system + 一条 user(无相邻同 role、无 image、不依赖 pairs 内部交替)。
    expect(msgs.length).toBe(2);
    const userText = msgs[1].content as string;
    expect(userText).toContain("navigate");
    expect(userText).toContain("FOUND_PRICE_42");
  });
});
```

- [ ] **Step 2: 跑测试,验证失败**

Run: `pnpm test src/lib/agent/compact-react-window.test.ts`
Expected: FAIL — `buildCompactionMessages` 未导出

- [ ] **Step 3: 实现 buildCompactionMessages + createDefaultSummarizer**

在 `compact-react-window.ts` 顶部 import 区补:

```typescript
import type { ModelConfig } from "../model-router/types";
import { streamChat } from "../model-router";
```

文件末尾追加:

```typescript
/** 把一条步骤 message 转成可读 transcript 行(只取 text / tool_use 名/args / tool_result 文本,丢弃 image)。 */
function serializeStepMsg(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content;
  const parts: string[] = [];
  for (const b of msg.content as ContentBlock[]) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "tool_use") parts.push(`Action: ${b.name}(${JSON.stringify(b.input)})`);
    else if (b.type === "tool_result") parts.push(`Result: ${b.content}`);
    // image 跳过
  }
  return parts.join("\n");
}

const COMPACTION_SYSTEM =
  "你在压缩一个网页 AI agent 的早期步骤。用两个带标签的部分简洁总结,不要别的内容:\n" +
  "动作: 依次执行了哪些动作;\n" +
  "发现: 页面上观察到的关键数据/数值/进度(保留具体数字、价格、ID、表单进度)。\n" +
  "省略 DOM 元素列表。尽量简短。";

/** 纯函数:把待压步骤对拼成 compaction 用的 LLM 消息序列。 */
export function buildCompactionMessages(pairs: AgentMessage[]): AgentMessage[] {
  const transcript = pairs.map(serializeStepMsg).join("\n");
  return [
    { role: "system", content: COMPACTION_SYSTEM },
    { role: "user", content: `以下是早期步骤记录,请按两部分格式压缩总结:\n\n${transcript}` },
  ];
}

/** 默认 summarizer:用当前 model 跑无 tool streamChat,收集纯文本(模式同 generateStuckSummary)。 */
export function createDefaultSummarizer(modelConfig: ModelConfig): ReactSummarizer {
  return async (pairs, signal) => {
    if (signal.aborted) return null;
    const msgs = buildCompactionMessages(pairs);
    let text = "";
    try {
      for await (const ev of streamChat(modelConfig, msgs, signal, [])) {
        if (signal.aborted) return null;
        if (ev.type === "text-delta") text += ev.text;
        else if (ev.type === "error") return null;
        // tool-call-* 忽略(未提供 tool)
      }
    } catch {
      return null;
    }
    const t = text.trim();
    return t.length > 0 ? t : null;
  };
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm test src/lib/agent/compact-react-window.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/compact-react-window.ts src/lib/agent/compact-react-window.test.ts
git commit -m "feat(agent): 默认 compaction summarizer (buildCompactionMessages + streamChat) (#58)"
```

---

## Task 4: 接入主循环 pipeline + 放宽 sliding window cap

把 `compactReactWindow` 接到 `loop.ts` 主循环:在 wire-time 整形之前 in-place 压缩 `history`;`applySlidingWindow` 改传 `BIG_CAP` 兜底。`generateStuckSummary` 路径不接入(YAGNI)。这部分以 build + 现有测试不回归为验收(集成路径难纯单测,模式同既有)。

**Files:**
- Modify: `src/lib/agent/loop.ts:1300-1319`(主循环 pipeline)
- Modify: `src/lib/agent/loop.ts`(import 区)

- [ ] **Step 1: 加 import + BIG_CAP 常量**

在 `loop.ts` import 区(`applySlidingWindow` 那行附近,约 33-35)之后补:

```typescript
import { compactReactWindow, createDefaultSummarizer } from "./compact-react-window";
import { resolveProviderMeta } from "../model-router/providers/registry";
```

在文件常量区(任意 top-level)加:

```typescript
/** #58 — react 段 sliding-window 放宽后的兜底上限。正常由 token 阈值先触发 compaction。 */
const REACT_BIG_CAP = 60;
/** #58 — provider 元数据缺失时的回退上下文窗口(与 window-token-budget 一致)。 */
const COMPACTION_FALLBACK_MAX_TOKENS = 32_000;
```

- [ ] **Step 2: 在主循环 pipeline 插入 compaction**

定位 `loop.ts:1300-1319` 现有片段:

```typescript
      // Apply sliding window
      const windowedHistorySlid = applySlidingWindow(history);
```

替换为(在 sliding window 之前先 in-place compaction,并放宽 cap):

```typescript
      // #58 — 任务内 react 段 LLM compaction(IN-PLACE 改 history,持久化随 onStepSnapshot)。
      // 在 wire-time 整形之前:超 provider token 阈值时把最旧步骤摘成合成对,保住早期发现。
      const compactionMeta = await resolveProviderMeta(modelConfig.provider);
      const compactionMaxTokens = compactionMeta?.maxContextTokens ?? COMPACTION_FALLBACK_MAX_TOKENS;
      await compactReactWindow(
        history,
        compactionMaxTokens,
        createDefaultSummarizer(modelConfig),
        signal,
      );

      // Apply sliding window（react cap 放宽为 BIG_CAP，react 段长度主要由 compaction 控制）
      const windowedHistorySlid = applySlidingWindow(history, REACT_BIG_CAP);
```

- [ ] **Step 3: 跑全量测试,确认无回归**

Run: `pnpm test`
Expected: PASS — 全部测试通过(含已有 loop / window / synth 测试)。

- [ ] **Step 4: 跑 build,确认类型与 invariant**

Run: `pnpm build`
Expected: 成功(`tool-names.ts` / `tools.ts` build-time invariant 不受影响;无类型错误)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(agent): 主循环接入 react compaction + 放宽 sliding window cap (#58)"
```

---

## 收尾

- [ ] **Step 1: 全量验证**

Run: `pnpm test && pnpm build`
Expected: 测试全绿 + build 成功。

- [ ] **Step 2: 开 PR**

```bash
gh auth switch --user WiseriaAI
git push -u origin feat/react-compaction
gh pr create --base main --title "feat(agent): 任务内 react 段 LLM compaction (#58 子点 b)" --body "实现 docs/specs/2026-05-22-task-internal-compaction.md。详见 spec。Closes #58 子点 (b)。"
```

> 注意:本分支已含 spec + plan 文档的 commit;PR 会一并带上。

---

## 自审记录(writing-plans self-review)

**Spec 覆盖**:
- §3 状态模型(in-place 持久重写)→ Task 2 循环 B(`history.splice`)+ Task 4(`onStepSnapshot` 已有,无需新代码)。✓
- §4 算法(fast path / 三块切分 / victim 累积 / 单次 LLM)→ Task 2 循环 A+B。✓
- §4 触发判定用 elide 后大小 → 循环 A `estimateTokens(elideStaleObservations(history))`。✓
- §4 常量 KEEP_RECENT/BIG_CAP/阈值 → Task 2(KEEP_RECENT)+ Task 4(BIG_CAP/fallback)。✓
- §5 合成对结构(ContentBlock[] 双条 + tag + escape)→ Task 2 `buildSyntheticPair` + Task 1 tag。✓
- §6 摘要器接口 + 默认实现 → Task 2(type)+ Task 3(buildCompactionMessages/createDefaultSummarizer)。✓
- §7 失败回退(null/abort 跳过)→ Task 2 循环 C。✓
- §9 测试清单 → Task 2 三循环 + Task 3 纯函数测试。✓
- §10 改动清单(wrapper/snapshot/loop/不动 budget&elide&panel)→ Task 1+4。✓
- §10 generateStuckSummary 不接入 → Task 4 描述明示。✓

**Placeholder 扫描**:无 TBD/TODO;每个 code step 给了完整代码。✓

**类型一致性**:`ReactSummarizer`(Task 2 定义)在 Task 3 `createDefaultSummarizer` 返回、Task 4 注入一致;`compactReactWindow(history, maxContextTokens, summarizer, signal)` 四参签名跨 Task 2/4 一致;`isCompactedUserMsg` 导出名跨测试一致;`COMPACTED_TAG` 与 Task 1 的 `untrusted_compacted_steps` 一致。✓
