# Local Daemon Bridge（插件 ↔ 本地进程打通，终局形态）

- **日期**：2026-07-05
- **状态**：Spec 定稿（brainstorm 决策已全部确认）
- **来源**：本地 session brainstorming（superpowers:brainstorming），决策人 wenkang
- **参考实现**：steipete/summarize（native host + daemon 形态）、Claude Code Chrome 集成（native host 同构 + 已知坑）

## 1. 背景与目标

Pie 当前是纯 MV3 扩展，三个能力天花板：

1. **假 skill**：skill 只能提示词化，script 无法执行（MV3 CSP 禁 eval，sandbox iframe 只能纯计算，见 issue #68/#69）
2. **无本地 Agent 接力**：页面操作产出无法交棒给 Claude Code / Codex 继续重活，生态位断裂
3. **无本地 MCP**：stdio 类本地 MCP server 完全不可达（remote MCP 理论可直连但同样未做）

根因：没有本地进程作为扩展与本地世界的桥。本 spec 定义**终局形态**（跳过验证性 Phase 0，一步到位）：常驻 daemon + native messaging host，六个能力面全量落地。

战略对应：楔子 B「多 Agent 互通、Pie = source」——Pie 同时成为本地 Agent 的 browser tool provider。

## 2. 已确认决策（brainstorm 结论，不再重议）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 方向性 | **双向对等**：Pie → 本地（接力/MCP/skill），本地 Agent → Pie（浏览器工具）。daemon 必须常驻 |
| D2 | skill 执行主体 | **daemon 内置执行器**，不依赖用户装了 Claude Code/Codex；纯计算脚本仍走 #68 MV3 sandbox，不进 daemon |
| D3 | 接力形态 | **round-trip（headless 流式回传）与 hand-off（交棒交互式 session）都要** |
| D4 | MCP 配置源 | **daemon 持有**（`~/.pie/mcp.json`，兼容 Claude Desktop 格式）+ 一键导入已有 Claude Code / Claude Desktop 配置；Pie 设置页是管理 UI |
| D5 | 授权粒度 | **分级授权**（见 §6 矩阵），复用 HITL panel-request 原语加 kinds |
| D6 | 技术栈/分发 | **TypeScript + bun compile 单二进制**，三平台交叉编译；brew + curl 脚本分发 |
| D7 | 连接拓扑 | **B：native messaging host（薄透传）+ unix socket + 常驻 daemon**。不用裸 localhost WS，不要 token 配对仪式 |

## 3. 架构

```
Chrome ext (SW)
   │ chrome.runtime.connectNative("ai.wiseria.pie")
   │ （长连接，双向，manifest allowed_origins 锁扩展 ID）
   ▼
pie host（薄，Chrome 管生命周期，纯透传）
   │ unix domain socket ~/.pie/daemon.sock（0600；Windows named pipe）
   ▼
pie daemon（常驻，launchd / systemd user unit / Scheduled Task，KeepAlive）
   ├─ skill 执行器（bun subprocess 沙箱）
   ├─ stdio MCP 代理（spawn/懒启动本地 MCP servers）
   ├─ agent runner（spawn claude -p / codex exec，流式回传）
   └─ 反向 MCP server（`pie mcp`，本地 Agent 调 Pie 浏览器工具）
```

### 3.1 单二进制 `pie`（bun compile）

| 子命令 | 职责 |
|--------|------|
| `pie daemon` | 常驻服务本体，监听 socket |
| `pie host` | native messaging host 入口。stdin/stdout（Chrome 4 字节长度前缀 framing）↔ daemon socket（ndjson）双向透传，无业务逻辑 |
| `pie mcp` | stdio MCP server 入口，供本地 Agent `claude mcp add pie -- pie mcp` 接入；内部连 daemon socket |
| `pie install` | 写 native host manifest（`ai.wiseria.pie.json`）到所有**已安装**浏览器目录（Chrome/Edge/Brave/Arc）+ 注册常驻服务 |
| `pie doctor` | 诊断：manifest 存在性、daemon 存活、claude/codex 可执行性、socket 权限 |

### 3.2 扩展侧新增

- `src/background/local-bridge.ts`：connectNative 连接管理、`hello` 能力协商、断线指数退避重连
- 本地类 tools：`handoff_to_agent` / `run_local_agent` / `run_skill_script`（daemon 路径）+ MCP 工具动态注册（`mcp_<server>_<tool>`，接渐进式工具披露能力包机制）
- HITL panel-request 新 kinds（§6）
- 设置页「本地」tab：检测/安装引导/MCP server 管理/授权管理/audit 入口

### 3.3 协议

- JSON-RPC 2.0，**双向**（两个方向都可发 request / notification）
- `hello` 握手：`protocolVersion` + capabilities 列表；两侧各向后兼容一个版本
- 类型权威源：`src/types/local-bridge.ts`，daemon 同仓库相对 import，**不复制**
- native messaging host→ext 单条 1MB 硬限 → 协议层内置分块（文件回传 chunked base64）

## 4. 六个能力面

### 4.1 hand-off（交棒交互式 session）

`handoff_to_agent(target: "claude"|"codex", context: string, files: string[])` → HITL 卡（目标、工作目录、文件清单）→ daemon 建 `~/pie-handoffs/<date>-<slug>/`，落盘 `context.md` + 产出文件 → 唤起终端（app 可配置：Terminal/iTerm/…）运行目标 Agent 交互式 session（预注入「读 context.md 继续」）→ 侧栏「已交棒 + 路径」卡。

### 4.2 round-trip（headless 回传）

`run_local_agent(target, prompt, files?, cwd?)` → HITL 卡 → daemon spawn `claude -p --output-format stream-json` / `codex exec --json` → 流式 stdout 经桥回侧栏，渲染嵌套子 Agent 进度 → 完成结果作为 observation 回 agent loop。用户 abort → daemon kill 进程组。

### 4.3 skill 真执行

- skill frontmatter 新增 `capabilities.local_exec`：`{ runtime: "node", entry: "scripts/x.ts", permissions: { fs: ["workspace"], network: ["api.example.com"] } }`
- `run_skill_script` → HITL（按 skill 记住，卡展示 permissions 声明；声明变更 → 重新授权）→ daemon 在 `~/.pie/skills/<id>/workspace/` 执行：bun subprocess、默认 60s 超时、输出 1MB 上限、fs 限 workspace、网络按域名白名单
- 结果包 `<untrusted_skill_content>` 回 observation
- **分界与路由**：`run_skill_script` 是**同一个工具**，按 permissions 声明自动路由——无 fs/network/exec 声明的纯计算脚本走 #68 MV3 sandbox（无需 daemon、无需授权卡），有声明的走 daemon。LLM 与 skill 作者无需感知两条执行路径；daemon 未安装时带声明的 skill 报结构化「需要本地组件」错误

### 4.4 stdio MCP 代理

- 配置 `~/.pie/mcp.json`（Claude Desktop 格式兼容）；设置页一键导入 `~/.claude.json` / `claude_desktop_config.json`
- daemon 懒启动 server 进程 → 工具列表经桥下发 → 扩展动态注册 `mcp_<server>_<tool>` 进 tool registry
- 调用经 §6 分级授权；结果包 `<untrusted_mcp_result>`

### 4.5 反向：本地 Agent 调 Pie

- 入口 `pie mcp`（stdio）；工具面 = Pie 浏览器工具子集：`list_tabs` / `read_page` / `search_page` / `screenshot` / `act` / `navigate`
- 调用链：本地 Agent → daemon → 桥 → 扩展现有 tool 执行路径，映射为独立 **bridge session**（复用 per-session sandbox 语义）
- 侧栏常驻指示器（「本地 Agent 已连接」）+ 一键断开
- 多浏览器同时在线：路由到最近活跃连接；工具入参可显式指定 browser

### 4.6 安装/配对

设置页「本地」tab → connectNative 试连检测 → 未装：展示一行安装命令（brew / curl，复制按钮）→ 用户跑 `pie install` → 侧栏轮询重连自动亮绿。认证 = extension ID allowlist，无 token。

## 5. Manifest 变更

- `nativeMessaging` 进 **`optional_permissions`**：用户开启本地打通时才请求，纯 BYOK 用户零感知

## 6. 安全模型

威胁模型变化：页面内容（untrusted）→ LLM → **本地代码执行**。三层防线：

### 6.1 分级授权矩阵（HITL panel-request 新 kinds）

| 能力 | 首次 | 后续 | 理由 |
|------|------|------|------|
| hand-off 交互式 | HITL 卡 | 记住 | 人接手终端，注入无法自动执行 |
| round-trip headless | HITL 卡（完整 prompt + cwd 原文） | 可「本 session 记住」 | headless 即自动执行，默认逐次 |
| skill script | HITL 卡（permissions 声明） | 按 skill 记住 | 声明式权限，变更即重授权 |
| MCP 工具 read-class | 按 server 首次 | 记住 | MCP annotations + 保守默认归类（对齐 `tool-names.ts` read/write 思路） |
| MCP 工具 write-class | HITL 每次 | 可按 server+tool 记住 | 写操作是注入主攻击面 |
| 反向浏览器控制 | 配对时一次 | 常驻指示器 + 一键断开 | 发起方在 trusted 侧，风险在可见性 |

**Invariant：write 类本地动作不存在静默路径。** 授权卡展示的 prompt/命令一律原文，不经 LLM 转述。本矩阵是「工具语义即问人」的延伸，不是 risk-classifier 框架拦截的复活。

### 6.2 信任边界

- 新增 wrapper：`untrusted_local_agent_output` / `untrusted_mcp_result`（`untrusted_skill_content` 已有）
- 按双表 invariant 登记 `UNTRUSTED_WRAPPER_TAGS`（untrusted-wrappers.ts）+ `WRAPPER_TAGS_LIST`（page-snapshot.ts）

### 6.3 daemon 侧防线

- socket 0600 仅当前用户；native host manifest `allowed_origins` 锁扩展 ID（唯一准入）
- audit log `~/.pie/logs/audit.jsonl`：每个本地动作记 时间/session/命令原文/授权方式/结果
- skill 执行器：fs 限 workspace、网络域名白名单、超时、输出上限

## 7. 错误处理与降级

| 场景 | 行为 |
|------|------|
| daemon 未安装 | 本地类 tool **不注册**（LLM 看不到，不幻觉调用）；设置页安装引导 |
| 桥断连 | tool 调用返回结构化错误 observation；host 侧指数退避重连 |
| daemon 崩溃 | launchd/systemd KeepAlive 拉起 |
| host 崩溃 | ext onDisconnect → 重连（Chrome 重新 spawn host） |
| claude/codex 未装 | `pie doctor` 检测；`run_local_agent` 返回结构化「未检测到」错误 |
| 版本不匹配 | `hello` 协商失败 → 设置页提示升级（binary 或扩展） |

**Invariant：扩展离开 daemon 100% 完整可用**——BYOK 核心体验零依赖本地组件。

## 8. 测试

- 协议层（framing / 分块 / JSON-RPC 路由）：纯函数单测，两侧共享
- daemon 集成：bun test，真 daemon + fake socket client
- 扩展侧：vitest mock `chrome.runtime.connectNative`（沿用现有 chrome mock 模式）
- 真机手测清单：安装、配对、六能力面、断连恢复、双浏览器并连

## 9. 仓库、CI、交付

- 主仓库 `daemon/` 子目录，独立 package.json（bun）；协议类型 import `src/types/local-bridge.ts`
- CI：daemon job（bun test + 三平台交叉编译 artifact）
- release workflow：扩展 zip + 三平台二进制同 release 发布；brew tap + curl 安装脚本
- 签名：macOS notarization（需 Apple Developer 账号）；Windows v1 unsigned + SmartScreen 文档说明，终局补签名

## 10. 非目标

- 不做裸 localhost WebSocket / token 配对（D7 已否）
- 不做 remote MCP（streamable HTTP 直连扩展可独立做，不在本 spec 范围）
- daemon 不做通用 shell 执行工具（只有 4.1–4.3 三条受控路径能 spawn 进程）
- 不复活 risk-classifier 式框架拦截（分级授权只挂在工具语义上）
- 纯计算 skill 脚本不进 daemon（走 #68）

## 11. 实现期验证点（非设计 TBD）

1. bun compile 产物作为 native messaging host 的 stdio framing 兼容性（大消息、背压）——实现第一步先做 spike
2. Windows named pipe + Scheduled Task 注册细节（参考 summarize 的 schtasks 方案）
3. `codex exec --json` 输出格式的稳定性（Codex CLI 迭代快，runner 做 per-target adapter）
4. 终端唤起的跨平台矩阵（macOS `open -a`；Linux x-terminal-emulator；Windows Windows Terminal / conhost）
