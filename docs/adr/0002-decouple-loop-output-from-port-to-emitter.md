# runAgentLoop 的输出从 port 解耦为 emitter sink

headless schedule run 没有 side panel 的 `chrome.runtime.Port`，但 `runAgentLoop` 内 10+ 处直接 `port.postMessage(...)` 广播流式输出（`chat-chunk` / `thinking-chunk` / `chat-done` / `chat-error` / `agent-step` / `needs-file-access`）。

**决定**：把 `AgentLoopContext.port` 抽象为 `ctx.emit(msg)` sink。前台场景 `emit = port.postMessage`；headless 场景 `emit` 把流式 chunk 丢弃、把 `done`/`error` 落进 Run record。loop 内所有 `port.postMessage` 改成 `ctx.emit`。

**为什么安全**（已核实，非推断）：loop 的控制流不依赖 port inbound——`loop.ts` 无 `port.onMessage` / `addListener`，无 `new Promise` 等用户 confirm/input（confirm 层早已移除），abort 走 `signal: AbortSignal`。所以解耦只动"输出去向"，不动 loop 的推进（LLM + tool 自循环）/ 终止（`done`/`fail`/纯文本）/ 中断（AbortSignal）三要素。顺带松绑 `loop.ts` 自陈的"`emitDone` 闭包耦合 Chrome 不可单测"这笔技术债。

**被拒的备选**：fake port——构造一个满足 `chrome.runtime.Port` 接口的假对象喂进去让 loop 零改动。拒因：固化脏耦合、要 stub 整个 Port 接口、把"广播给 UI"和"持久化"混在一个假 `postMessage` 里，语义脏。

**附带保证**：需要用户当场介入的副作用（`needs-file-access`）在 headless 下 `emit` 丢弃 → 对应 tool 返回 error → agent 自行处理或 `fail`，**不阻塞 loop**。无人值守因此永不僵死在一个等不来的用户响应上。
