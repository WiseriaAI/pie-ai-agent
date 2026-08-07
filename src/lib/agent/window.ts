import type { AgentMessage } from "../model-router/types";

/**
 * Returns the index of the first assistant message whose content is a
 * ContentBlock[] array — i.e. the ReAct loop start. Returns -1 if none.
 *
 * Shared by window-token-budget.ts and compact-react-window.ts so a future IR
 * shape change only needs one edit site.
 *
 * ── 这个文件曾经还有一个 applySlidingWindow ─────────────────────────────────
 *
 * 它是 2026-04 Phase 2 引入的「12-step sliding window」。当时它是唯一的上下文
 * 控制手段——没有 compaction、没有 stale-snapshot elision、没有 token budget
 * guard，任务也跑不过 MAX_STEPS=30。它按**对数**砍 react 段，因为那时还没有
 * 按 token 判断的能力。
 *
 * 那些前提后来全变了。今天上下文由三样东西按**真实 token** 控制：
 *   - compactReactWindow —— 超窗口 80% 时把最旧步骤摘要成合成对；
 *   - applyTokenBudget —— 超窗口 80% 时丢弃 head 里最旧的对；
 *   - elideStaleObservations —— 每轮把 stale 页面快照压成 marker（实测 99.3%）。
 *
 * 而按对数砍在大窗口模型上纯粹是自伤：60 对可能才 50k token，离 1M 窗口差 20
 * 倍，照砍不误；砍的又是最开头，正是自动 prefix caching（deepseek /
 * openai-compat / gemini）唯一依赖的稳定前缀。实测真机 s82：msgs 162→122，
 * 命中率从 98% 掉到 29%。
 *
 * 它还有过一个更隐蔽的缺陷：这是个无状态纯函数，而 history 仍在增长，于是一旦
 * 对数越过 band，`slice(-maxSteps)` 每轮都重取「最后 60 对」，砍点每轮后移一对
 * ——命中率再没回来（cached 冻在 15872 连续十轮不动）。那个缺陷被独立修过一次
 * （e10763c0，把丢弃量量化到 slideBatch 整数倍，使砍点在一个 batch 内固定），
 * 但那只是把伤害从「每步一次」降到「每 20 步一次」。删掉整个机制则是零，而且
 * 上面三道按 token 的防线本来就该承担这件事。
 *
 * 删掉之后 react 段是纯 append-only，前缀天然稳定。
 */
export function findReactStartIdx(messages: AgentMessage[]): number {
  return messages.findIndex(
    (m) => m.role === "assistant" && Array.isArray(m.content),
  );
}
