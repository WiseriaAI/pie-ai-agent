# abort 保留完整历史、自动续接 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 abort（用户中途停止）不再把任务当"已结束"压缩成一句摘要，而是保留完整 raw 历史；用户在同一 session 直接输入下一条消息时，自动以完整历史续接（对齐 Claude Code）。

**Architecture:** 三个发现驱动了最小改动设计——(1) abort 时 history 总停在完整 round-trip 边界（合法可续接）；(2) 每步 `onStepSnapshot` 已把完整 history 持久化进 `session_${id}_agent`，是 abort 的 tombstone 才清空它；(3) 续接新消息可复用现成 pending-instructions 通道。因此 B 的核心 = **abort 时不写清空 tombstone**（保留最后 step snapshot）+ **chat-start 检测保留历史 → 走 resume 风格 seed**。emitDone 闭包不可单测，故把决策抽成两个纯函数（`buildDoneSnapshot` / `planAbortResumeSeed`）承载测试。

**Tech Stack:** TypeScript, vitest + chromeMock（`@/test/setup`），既有 `runAgentLoop` 的 `resumedAgentMessages`/`resumedFromStep` 续接通道。

**Spec:** `docs/specs/2026-06-06-abort-preserve-history.md`

**Worktree:** `.claude/worktrees/fix+abort-preserve-history`（分支 `worktree-fix+abort-preserve-history`）。A 的 panel 修复已在此 worktree（`port-handlers.ts` + `.test.ts`，22 passed）。

---

## 关键边界（实现前必读）

- **step0 abort**：第一步 streaming 中就 abort，`_agent` 仍是 `(stepIndex=0, agentMessages=[])`。续接判定 `agentMessages.length>0 && stepIndex>0` 天然为 false → 走正常新 task。无需特判。
- **image-bearing 任务**：`emitDone` 的 `evictSession` 会清图片缓存，且 R14 规定 image-bearing in-flight 不可 resume（字节不在 storage）。故 **abort + `hasImageContent` 维持旧行为**（仍写 tombstone + synth 压缩）；只有非 image 的 abort 才保留历史。
- **pin 保留**：abort 续接要落在原任务 tab 上，故 abort 路径**跳过 `onTaskDone`**（不降级 task-mode pin）。续接 chat-start 的 `upgradeAutoToTaskAtChatStart` 是 idempotent（已 task 则 no-op）；reload→resume 路径读 `meta.pinnedTabs` 也因此完好。
- **相邻 user role**：续接 history 末尾是 `user(tool_result)`，追加的新 user 消息造成相邻 user——由 loop 既有的 `validateAndRepairAdjacentRoles`（streamChat 前）合并，与现有 resume + #34 drain 路径同一保证，无需新处理。
- **carryover 协调**：handleChatStream 在续接判定前已 `drainPending`（index.ts:1056）把之前 abort 的 pending merge 进 `messages` 最后一条。续接取 `messages` 最后一条作为追加 user turn 即可，carryover 已含其中。

---

## Task 1: abort 保留历史 —— `buildDoneSnapshot` 纯函数 + emitDone 接线

**Files:**
- Modify: `src/lib/agent/loop.ts`（emitDone 闭包 ~1009-1072；新增导出纯函数 `buildDoneSnapshot` 放在 `buildSessionAgentTombstone` 之后 ~597）
- Test: `src/lib/agent/loop.test.ts`（紧跟现有 `buildSessionAgentTombstone` describe ~182-228）

- [ ] **Step 1: 写失败测试**

在 `loop.test.ts` 现有 `buildSessionAgentTombstone` 测试块之后加入：

```typescript
describe("buildDoneSnapshot — abort preserves history, others tombstone", () => {
  it("abort (no image) → returns null so emitDone skips the write (history preserved)", () => {
    expect(buildDoneSnapshot("abort", /*hasImageContent*/ false, null, undefined)).toBeNull();
  });

  it("abort WITH image → still tombstones (R14: image bytes not in storage, no resume)", () => {
    const snap = buildDoneSnapshot("abort", /*hasImageContent*/ true, "[任务中断] 任务已取消", undefined);
    expect(snap).not.toBeNull();
    expect(snap!.agentMessages).toEqual([]);
    expect(snap!.stepIndex).toBe(0);
  });

  it("success → tombstone carrying the synth summary", () => {
    const snap = buildDoneSnapshot("success", false, "<untrusted_prior_task_summary>已完成: x</untrusted_prior_task_summary>", undefined);
    expect(snap!.agentMessages).toEqual([]);
    expect(snap!.stepIndex).toBe(0);
    expect(snap!.lastTaskSynth).toContain("已完成");
  });

  it("fail / max-steps → tombstone (non-null)", () => {
    expect(buildDoneSnapshot("fail", false, "s", undefined)).not.toBeNull();
    expect(buildDoneSnapshot("max-steps", false, "s", undefined)).not.toBeNull();
  });

  it("carries contextUsage through to the tombstone", () => {
    const usage = { lastInputTokens: 10, lastOutputTokens: 2, totalInputTokens: 10, totalOutputTokens: 2, contextTokens: 12, maxContextTokens: 100 } as SessionAgentState["contextUsage"];
    const snap = buildDoneSnapshot("success", false, "s", usage);
    expect(snap!.contextUsage).toEqual(usage);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/loop.test.ts -t "buildDoneSnapshot"`
Expected: FAIL — `buildDoneSnapshot is not defined`（确认导入会报错，先在 import 行加 `buildDoneSnapshot`）。

- [ ] **Step 3: 实现纯函数**

在 `loop.ts` 中 `buildSessionAgentTombstone`（~597）之后新增：

```typescript
/**
 * B（abort 保留历史）— 决定一次任务终止应写入 `session_${id}_agent` 的快照。
 *
 * - abort 且非 image 任务 → 返回 null：emitDone 跳过写入，保留最后一次
 *   per-step snapshot（完整 round-trip history + stepIndex>0），供下次
 *   chat-start 以 resume 风格续接（见 planAbortResumeSeed）。
 * - 其它（success / fail / max-steps，或 abort 但 hasImageContent）→ 写
 *   tombstone 清空历史 + 折叠 synth 摘要，维持既有压缩行为。R14：image-bearing
 *   in-flight 不可 resume（字节不在 storage），故 abort+image 仍走压缩。
 *
 * 纯函数，便于单测（emitDone 闭包本身耦合 Chrome 不可单测）。
 */
export function buildDoneSnapshot(
  terminationReason: TerminationReason,
  hasImageContent: boolean,
  synth: string | null,
  carryUsage: SessionAgentState["contextUsage"] | undefined,
): SessionAgentState | null {
  if (terminationReason === "abort" && !hasImageContent) return null;
  return buildSessionAgentTombstone(synth ?? undefined, carryUsage);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/agent/loop.test.ts -t "buildDoneSnapshot"`
Expected: PASS（5 个用例）。

- [ ] **Step 5: emitDone 接线**

在 `loop.ts` emitDone 闭包内做两处改动。

(a) 顶部 pin 清除——abort 保留 pin（~1024-1033）：

```typescript
    // B — abort 保留 task-mode pin，使续接落在原任务 tab。其它终止照常降级。
    // hasImageContent 的 abort 仍视为压缩路径（见下），但 pin 降级与否对其
    // 续接无意义（image 不续接），按 abort 统一保留即可。
    if (ctx.onTaskDone && terminationReason !== "abort") {
      try {
        await ctx.onTaskDone();
      } catch (e) {
        console.warn(`[agent] onTaskDone (task-pin clear) failed for session=${ctx.sessionId}:`, e);
      }
    }
```

(b) 末尾 tombstone 写入改用 `buildDoneSnapshot`（~1058-1071）：

```typescript
    if (ctx.onStepSnapshot) {
      const prev = await getSessionAgent(sessionId);
      // B — abort（非 image）返回 null：跳过写入，保留最后 step snapshot 的
      // 完整 history，供续接。其它返回 tombstone（清空 + synth 折叠）。
      const doneSnapshot = buildDoneSnapshot(
        terminationReason,
        hasImageContent,
        synth,
        prev?.contextUsage,
      );
      if (doneSnapshot) {
        ctx.onStepSnapshot(doneSnapshot).catch((e) => {
          console.warn(`[agent] done snapshot failed for session=${ctx.sessionId}:`, e);
        });
      }
    }
```

注：`synth` 仍按现状计算（无害；abort 非 image 路径不使用其结果）。`hasImageContent` 是 loop 闭包内既有变量。

- [ ] **Step 6: 回归 loop 测试**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: PASS（全部，含既有 emitDone synth path 测试不受影响）。

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent/loop.ts src/lib/agent/loop.test.ts
git commit -m "feat(loop): abort 保留完整历史而非写清空 tombstone (B Task 1)"
```

---

## Task 2: chat-start 续接 seed —— `planAbortResumeSeed` 纯函数

**Files:**
- Create: `src/lib/agent/abort-resume.ts`
- Test: `src/lib/agent/abort-resume.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { planAbortResumeSeed } from "./abort-resume";
import type { SessionAgentState } from "@/lib/sessions/types";
import type { ChatMessage } from "@/lib/model-router";

function agent(overrides: Partial<SessionAgentState> = {}): SessionAgentState {
  return {
    agentMessages: [
      { role: "system", content: "sys" },
      { role: "user", content: "<untrusted_user_message>do X</untrusted_user_message>" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
    pendingInstructions: [],
    stepIndex: 2,
    hasImageContent: false,
    ...overrides,
  } as SessionAgentState;
}

const newMsg: ChatMessage[] = [
  { role: "user", content: "actually, also do Y" },
];

describe("planAbortResumeSeed", () => {
  it("returns resume seed when agent has in-flight history (stepIndex>0, non-empty)", () => {
    const seed = planAbortResumeSeed(agent(), newMsg);
    expect(seed).not.toBeNull();
    expect(seed!.resumedFromStep).toBe(2);
    expect(seed!.resumedHasImageContent).toBe(false);
    // appended a wrapped user turn carrying the new message
    const last = seed!.resumedAgentMessages.at(-1)!;
    expect(last.role).toBe("user");
    expect(typeof last.content === "string" && last.content).toContain("also do Y");
    // original history preserved ahead of it
    expect(seed!.resumedAgentMessages.length).toBe(agent().agentMessages.length + 1);
  });

  it("returns null when agentMessages is empty (no in-flight history)", () => {
    expect(planAbortResumeSeed(agent({ agentMessages: [] }), newMsg)).toBeNull();
  });

  it("returns null when stepIndex is 0 (tombstone / fresh)", () => {
    expect(planAbortResumeSeed(agent({ stepIndex: 0 }), newMsg)).toBeNull();
  });

  it("returns null when savedAgent is null", () => {
    expect(planAbortResumeSeed(null, newMsg)).toBeNull();
  });

  it("returns null when hasImageContent (image not resumable — R14)", () => {
    expect(planAbortResumeSeed(agent({ hasImageContent: true }), newMsg)).toBeNull();
  });

  it("returns null when last message is not a user string", () => {
    expect(planAbortResumeSeed(agent(), [{ role: "assistant", content: "x" }])).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/abort-resume.test.ts`
Expected: FAIL — module not found / `planAbortResumeSeed is not defined`。

- [ ] **Step 3: 实现纯函数**

```typescript
import type { AgentMessage, ChatMessage } from "@/lib/model-router";
import type { SessionAgentState } from "@/lib/sessions/types";
import { buildMidTaskUserMessage } from "./loop-drain";

export interface AbortResumeSeed {
  resumedAgentMessages: AgentMessage[];
  resumedFromStep: number;
  resumedHasImageContent: boolean;
}

/**
 * B（abort 自动续接）— 若 session 的 agent 状态是一个 abort 留下的 in-flight
 * 中断点（非空 history + stepIndex>0 + 非 image），返回以完整历史续接的 seed：
 * 在保留的 raw agentMessages 末尾追加一条 wrapped user turn（携带用户新消息）。
 * 否则返回 null，调用方走正常新 task 路径。
 *
 * - hasImageContent → null：image bytes 不在 storage，无法续接（R14）。
 * - 新消息用 buildMidTaskUserMessage 包成 <untrusted_user_message>，与 #34
 *   drain 注入同一 wrapper（prompt-injection 防御）。
 * - 末尾相邻 user(tool_result)+user(new) 由 loop 的 validateAndRepairAdjacentRoles
 *   合并，无需在此处理。
 */
export function planAbortResumeSeed(
  savedAgent: SessionAgentState | null,
  messages: ChatMessage[],
): AbortResumeSeed | null {
  if (!savedAgent) return null;
  if (savedAgent.agentMessages.length === 0 || savedAgent.stepIndex <= 0) return null;
  if (savedAgent.hasImageContent) return null;

  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content !== "string") return null;

  const appended = buildMidTaskUserMessage([
    { chatMessageId: "abort-resume", content: last.content, createdAt: 0 },
  ]);
  if (!appended) return null; // unreachable (one item), defensive

  return {
    resumedAgentMessages: [...savedAgent.agentMessages, appended],
    resumedFromStep: savedAgent.stepIndex,
    resumedHasImageContent: savedAgent.hasImageContent,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/agent/abort-resume.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/abort-resume.ts src/lib/agent/abort-resume.test.ts
git commit -m "feat(agent): planAbortResumeSeed 纯函数 — abort 续接 seed (B Task 2)"
```

---

## Task 3: handleChatStream 接线续接路径

**Files:**
- Modify: `src/background/index.ts`（handleChatStream，`lastTaskSynth` 读取处 ~1136-1154 与 runAgentLoop 调用 ~1179-1218）

- [ ] **Step 1: 接线续接判定**

在 `const lastTaskSynth = synthAgent?.lastTaskSynth ?? null;`（~1136）之后、`let effectiveMessages = messages;`（~1138）之前，加入续接判定并改造 runAgentLoop 的 seed 参数。把现有 `effectiveMessages` 块包进 `else` 分支：

```typescript
    // B — abort 续接：若 synthAgent 是一个 abort 留下的 in-flight 中断点，
    // 以完整 raw 历史续接（在末尾追加用户新消息），而非从 panel 文本重建。
    // 与 lastTaskSynth 互斥：abort 不生成 synth；success/fail 清空历史。
    const abortResume = planAbortResumeSeed(synthAgent ?? null, messages);

    let effectiveMessages = messages;
    if (!abortResume && lastTaskSynth) {
      effectiveMessages = [
        ...messages.slice(0, -1),
        { role: "assistant" as const, content: lastTaskSynth },
        messages[messages.length - 1]!,
      ];
      clearLastTaskSynth(sessionId).catch((e) => {
        console.warn(`[sw] clearLastTaskSynth failed for session=${sessionId}:`, e);
      });
    }
```

(`planAbortResumeSeed` 从 `@/lib/agent/abort-resume` 导入——在文件 import 区加。)

- [ ] **Step 2: runAgentLoop 二选一传 seed**

在 runAgentLoop 调用（~1179）里，把 `messages: effectiveMessages,`（~1210）替换为按 `abortResume` 二选一：

```typescript
      // B — abort 续接走 resume 风格 seed（完整 raw 历史 + 追加新 user turn）；
      // 否则走多轮重建（effectiveMessages，可能含 lastTaskSynth 注入）。
      ...(abortResume
        ? {
            resumedAgentMessages: abortResume.resumedAgentMessages,
            resumedFromStep: abortResume.resumedFromStep,
            resumedHasImageContent: abortResume.resumedHasImageContent,
          }
        : { messages: effectiveMessages }),
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 0 errors（repo-wide 0 错是不变量）。

- [ ] **Step 4: cross-layer 集成测试**

**Files:** Create `src/__tests__/cross-layer/abort-resume.test.ts`

用 chromeMock 验证存储层不变量（不 mock loop，仿 `mid-task-recovery.test.ts`）：

```typescript
import { describe, it, expect } from "vitest";
import "@/test/setup";
import { chromeMock } from "@/test/setup";
import { planAbortResumeSeed } from "@/lib/agent/abort-resume";
import { buildDoneSnapshot } from "@/lib/agent/loop";
import type { SessionAgentState } from "@/lib/sessions/types";

const SID = "abort-resume-xlayer";

function seed(state: Partial<SessionAgentState>): void {
  chromeMock.storage.local.__store[`session_${SID}_agent`] = {
    agentMessages: [], pendingInstructions: [], stepIndex: 0, hasImageContent: false, ...state,
  } satisfies SessionAgentState;
}

describe("abort-resume cross-layer", () => {
  it("abort (non-image) → buildDoneSnapshot null → stored history survives → planAbortResumeSeed resumes", () => {
    const history = [
      { role: "system", content: "s" },
      { role: "user", content: "<untrusted_user_message>X</untrusted_user_message>" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    // last per-step snapshot already persisted the full history
    seed({ agentMessages: history as SessionAgentState["agentMessages"], stepIndex: 2 });

    // emitDone(abort) would compute this and SKIP the write:
    expect(buildDoneSnapshot("abort", false, null, undefined)).toBeNull();

    // storage therefore still holds the history
    const saved = chromeMock.storage.local.__store[`session_${SID}_agent`] as SessionAgentState;
    expect(saved.agentMessages.length).toBe(4);
    expect(saved.stepIndex).toBe(2);

    // next chat-start resumes it
    const resume = planAbortResumeSeed(saved, [{ role: "user", content: "continue please" }]);
    expect(resume).not.toBeNull();
    expect(resume!.resumedFromStep).toBe(2);
    expect(resume!.resumedAgentMessages.length).toBe(5);
  });
});
```

Run: `pnpm test src/__tests__/cross-layer/abort-resume.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/index.ts src/__tests__/cross-layer/abort-resume.test.ts
git commit -m "feat(sw): chat-start 检测 abort 中断点 → 完整历史续接 (B Task 3)"
```

---

## Task 4: 全量回归 + 构建门禁

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: 全绿（含 A 的 port-handlers、Task 1-3 新增、既有 loop/session/cross-layer 不回归）。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 3: build（构建期不变量）**

Run: `pnpm build`
Expected: 成功（`tool-names.ts` / `tools.ts` invariant 不 throw）。

- [ ] **Step 4: Commit（如有 lint/格式微调）**

```bash
git add -A && git commit -m "chore: abort-preserve-history 全量回归通过" || echo "nothing to commit"
```

---

## Task 5: 真机验证清单（SW / storage / port 集成，单测覆盖不到）

`pnpm build` 后 `chrome://extensions` Load unpacked `dist/`，逐项验证：

- [ ] **主路径**：发起一个多步任务（如"打开X并读取"），跑到第 2-3 步时点停止 → 屏幕保留已执行步骤 +（若停在流式中）保留正在流的 assistant 气泡（A 修复）→ 直接输入"继续，再做 Y" → LLM 接着原任务上下文执行（不重新开始、不丢失之前读到的内容）。
- [ ] **A 视觉**：在 LLM 正流式输出思考/正文时点停止 → 那段内容不再消失。
- [ ] **reload 路径**：停止后关闭再打开 side panel → 该 session 显示 "Resume task" 按钮 → 点击 → 完整历史续接（drift card 行为不变）。
- [ ] **放弃出口**：停止后点"新建 session" → 全新空白对话，不带旧历史。
- [ ] **success 不回归**：让任务正常完成 → 下一条新消息只带摘要桥接（lastTaskSynth），不带完整工具历史（context 不应异常变长）。
- [ ] **image 任务 abort**：发一个含图片输入的任务并中途停止 → 维持旧压缩行为（不续接完整历史，无 cache-miss 报错）。
- [ ] **pin 落点**：在特定 tab 上的任务停止后续接 → 续接仍作用于原 tab。

发现问题回到 `superpowers:systematic-debugging`，修复走 TDD。

---

## Self-Review（已执行）

- **Spec coverage**：spec 的 emitDone 分叉 → Task 1；chat-start 续接检测 → Task 2+3；新消息并入 → Task 2（buildMidTaskUserMessage 追加）；context 安全 → 依赖既有 sliding window（无新代码，真机 Step 5 验证）；status 落点 → Task 1 跳过 onTaskDone + 真机 reload 验证；放弃=新建 session → 无代码，真机验证。全覆盖。
- **Placeholder scan**：无 TBD/TODO；每个 code step 含完整代码。
- **Type consistency**：`buildDoneSnapshot(terminationReason, hasImageContent, synth, carryUsage)`、`planAbortResumeSeed(savedAgent, messages)`、`AbortResumeSeed{resumedAgentMessages,resumedFromStep,resumedHasImageContent}` 在 Task 1/2/3 间签名一致；`buildMidTaskUserMessage(PendingInstruction[])` 与既有定义一致；runAgentLoop 的 `resumedAgentMessages`/`resumedFromStep`/`resumedHasImageContent` 入参名与 loop.ts 既有定义一致。
