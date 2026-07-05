# Pie

Pie 是一个 BYOK Chrome 扩展（Manifest V3），让用户用自己的 API key 获得 AI 浏览器 agent 能力。本文件是领域术语表（glossary），只收本项目特有、易混淆的概念，不含实现细节。

## Scheduling

**Schedule**:
一条定时计划——一段 prompt 加调度参数（startAt / intervalMinutes / maxRuns），到点自动跑一个完整的常规 agent 任务。
_Avoid_: Loop（"Loop" 专指 agent 的 ReAct 循环 `runAgentLoop`，两者绝不可混用）, Cron job, Timer, Task

**Run**:
一条 Schedule 的某一次到点执行。每个 Run 有稳定的 recordId，1:1 对应一个 Session。
_Avoid_: Execution, Tick, Iteration, Trigger

**recordId**:
一个 Run 的稳定标识，独立于 sessionId，作为"事后针对某次执行再发起操作"的锚点。
_Avoid_: runId（口语可用，但持久字段统一叫 recordId）

**headless run**:
不依赖 side panel / port 的后台 agent 执行路径；Schedule 到点时由 chrome.alarms 唤醒 service worker 来跑，side panel 开不开都不影响。
_Avoid_: background task, detached run

## Local Daemon Bridge

（spec `docs/specs/2026-07-05-local-daemon-bridge.md`；ADR 0005/0006）

**Daemon**:
常驻本地进程（`pie daemon`，macOS launchd 拉起），扩展与本地世界的桥；是浏览器侧与本地 Agent 侧两个客户端的**会合点**，持有授权账本 + audit + skill 执行器 + MCP 代理 + agent runner。
_Avoid_: server, service, backend（"daemon" 专指这个进程，别泛化）

**Host**:
`pie host`——Chrome 用 `connectNative` 按需 spawn 的**薄透传**进程，只在 Chrome stdio framing ↔ daemon unix socket 之间搬字节，无业务逻辑，不 spawn daemon。
_Avoid_: proxy, bridge（"Bridge" 指整条通道，不是这个进程）, native host（口语可用，持久命名用 Host）

**Bridge**:
扩展 ↔ host ↔ daemon 这**整条双向通道**及其 JSON-RPC 协议，不是某个单独进程。
_Avoid_: 用 Bridge 指 Host 进程

**round-trip**:
接力形态之一——侧栏发起，daemon spawn `claude -p` headless，输出**流式回传**侧栏，用户不离开浏览器；子 Agent 结果作单条 observation 回 Pie loop。风险住在每次变的 prompt/cwd，故**永远弹卡、不持久授权**。
_Avoid_: hand-off（交棒到终端、不回传，是另一形态）, sub-agent

**hand-off**:
接力形态之一——上下文 + 文件落盘 `~/pie-handoffs/`，`open -a` 唤起终端里的**交互式** session，用户去终端继续；fire-and-forget，不回传。
_Avoid_: round-trip

**bridge session**:
反向调用（本地 Agent → Pie）时 daemon 侧建的 ephemeral session，仅作 CDP ownerToken / sandbox 记账；操作按 tabId 直打**真实活跃 tab**，不绑某个 Pie session 的 pinned tab。
_Avoid_: pinned tab session

**grant（授权账本）**:
daemon 持有的持久授权（`~/.pie/grants.json`），只记 `skill:<id>:<permsHash>` 和 `mcp:<server>[:<tool>]` 两类；批准发生在扩展 HITL 卡，强制与持久在 daemon（ADR 0006）。
_Avoid_: permission, consent（"cdp-consent" 等 panel-request kind 是 UI 层，grant 是 daemon 持久层）
