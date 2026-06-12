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
