# Local Daemon Bridge（插件 ↔ 本地进程打通，终局形态）

- **日期**：2026-07-05
- **状态**：Spec 定稿（brainstorm + grill 决策已全部确认）
- **来源**：本地 session brainstorming + grill-with-docs（决策人 wenkang）
- **参考实现**：steipete/summarize（native host + daemon 形态）、Claude Code Chrome 集成（native host 同构 + 已知坑 #54567）
- **相关 ADR**：`docs/adr/0005-local-daemon-rendezvous-topology.md`、`docs/adr/0006-daemon-owns-authorization-ledger.md`

## 1. 背景与目标

Pie 当前是纯 MV3 扩展，三个能力天花板：

1. **假 skill**：skill 只能提示词化，script 无法执行（MV3 CSP 禁 eval，sandbox iframe 只能纯计算，见 #68/#69）
2. **无本地 Agent 接力**：页面操作产出无法交棒给 Claude Code / Codex 继续重活，生态位断裂
3. **无本地 MCP**：stdio 类本地 MCP server 完全不可达

根因：没有本地进程作为扩展与本地世界的桥。本 spec 定义**终局形态**（愿景不打折：双向对等 + 常驻 daemon + 六能力面），并给出**分片构建顺序**（愿景一步到位 ≠ 一个 PR 落地）。

战略对应：楔子 B「多 Agent 互通、Pie = source」——Pie 同时成为本地 Agent 的 browser tool provider。

## 2. 已确认决策

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 方向性 | **双向对等**：Pie → 本地（接力/MCP/skill），本地 Agent → Pie（浏览器工具）。daemon 必须常驻 |
| D2 | skill 执行主体 | **daemon 内置执行器**（不依赖用户装了 Claude Code/Codex）；纯计算脚本仍走 #68 MV3 sandbox |
| D3 | 接力形态 | **round-trip（headless 流式回传）与 hand-off（交棒交互式 session）都要** |
| D4 | MCP 配置源 | **daemon 持有**（`~/.pie/mcp.json`，Claude Desktop 格式兼容）+ 一键导入已有配置 |
| D5 | 授权粒度 | **分级授权**；持久授权账本由 **daemon 持有**（`~/.pie/grants.json`），只记 skill + MCP 两类 |
| D6 | 技术栈/分发 | **TypeScript + bun compile 单二进制**，headless（无 GUI 壳） |
| D7 | 连接拓扑 | **native messaging host（薄透传）+ unix socket + 常驻 daemon**（见 ADR 0005） |
| D8 | 构建顺序 | **愿景锁终局，交付切成曳光弹 + 5 层增量**（见 §3） |
| D9 | 平台范围 | **v1 只支持 macOS**（unix socket / launchd / .pkg+公证）；Windows/Linux 后议 |
| D10 | 反向信任锚 | **MCP 配置时授权**（`claude mcp add pie`），无运行期配对；socket 0600 = 用户级信任边界 |

## 3. 构建顺序（D8）

愿景层（§1、§2、§6、ADR）保持终局不变；**交付**切成一根曳光弹 + 5 层增量，每层独立可发、各带自己那格授权。

- **Slice 0（曳光弹 / 地基）** ✅ **已实现（plan `docs/plans/2026-07-05-local-daemon-bridge-slice0.md`，12 task）**：`pie` 单二进制骨架 + `pie host` 透传 + `pie daemon` 空壳 + 扩展 `local-bridge.ts` + `hello` 握手（含 `protocolVersion`）+ `.pkg` 一键安装器 + `pie doctor`，端到端只打通 **round-trip（4.2）** 证明管子通。选 round-trip 作曳光弹：它单独证明「侧栏发起 → daemon spawn 子进程 → 流式回传」全链路，且不需要反向通道。**daemon 侧已端到端验证**（编译单二进制 61MB + socket hello 往返 + doctor）；**Chrome native-messaging 腿（装 pkg + 授权 + connectNative + 驱动 agent）待真机手测**。round-trip 曳光弹为**阻塞返回最终结果**，live 流式渲染 defer。
- **Slice 1**：hand-off（4.1）
- **Slice 2**：skill 执行器（4.3，吸收 #68 路由 + #69）
- **Slice 3**：stdio MCP 代理（4.4）
- **Slice 4**：反向 MCP server（4.5）
- **Slice 5**：安装/更新 UX 精修 + **daemon 自更新**（§9）。注：设置页「本地打通」**启用开关 + 实时状态提示**已在真机测试期从 Slice 5 前移进 Slice 0（否则 nativeMessaging 授权需用户手势、无 UI 无法触发，测试寸步难行）；Slice 5 只剩安装引导/自更新那部分 UX

## 4. 架构

```
Chrome ext (SW)
   │ chrome.runtime.connectNative("ai.wiseria.pie")
   │ （长连接，双向，manifest allowed_origins 锁扩展 ID）
   ▼
pie host（薄，Chrome 管生命周期，纯透传）
   │ unix domain socket ~/.pie/daemon.sock（0600）
   ▼
pie daemon（常驻，launchd KeepAlive；rendezvous 见 ADR 0005）
   ├─ skill 执行器（bun subprocess 沙箱）
   ├─ stdio MCP 代理（懒启动本地 MCP servers）
   ├─ agent runner（spawn claude -p / codex exec，流式回传）
   ├─ 授权账本 + audit（~/.pie/grants.json + logs/audit.jsonl）
   └─ 反向 MCP server（`pie mcp`，本地 Agent 调 Pie 浏览器工具）
```

### 4.1 单二进制 `pie`（bun compile，macOS）

| 子命令 | 职责 |
|--------|------|
| `pie daemon` | 常驻服务本体，监听 socket；launchd 拉起 |
| `pie host` | native messaging host 入口。stdin/stdout（Chrome 4 字节长度前缀 framing）↔ daemon socket（ndjson）双向透传，无业务逻辑 |
| `pie mcp` | stdio MCP server 入口，供本地 Agent `claude mcp add pie -- pie mcp` 接入；内部连 daemon socket |
| `pie doctor` | 诊断：manifest、daemon 存活、双版本兼容、claude/codex 可执行性、socket 权限 |

安装由 `.pkg` postinstall 完成（写 native host manifest + 注册 launchd），不是 `pie install` 子命令——去终端化（§9）。

### 4.2 round-trip（headless 回传，曳光弹）

`run_local_agent(target, prompt, files?, cwd?)` → HITL 卡（**每次**弹，展示 prompt + cwd **原文**）→ daemon spawn `claude -p --output-format stream-json` / `codex exec --json`（per-target adapter）→ 流式 stdout 经桥回侧栏，渲染嵌套子 Agent 进度（复用 ThinkingSection/AgentStepLine）→ 完成结果作为单条 observation 回 agent loop。

嵌套执行模型（Q5）：
- **阻塞式**：Pie loop 发出 tool call → 子 Agent 进度流式渲染进侧栏 → 子 Agent 最终结果 = observation → loop 继续
- **花费**：跑用户自己装的 Claude Code（自带 auth/订阅/key），Pie 不付费、不注入 key
- **时长/中止**：无人为超时；用户 abort Pie 任务 → daemon `kill` 掉 claude **进程组**
- **cwd（注入面）**：默认临时 workspace `~/pie-handoffs/<slug>/`（产出文件已 stage）；碰真实项目目录必须显式传 `cwd`，且授权卡上 cwd 原文可见
- **权限姿态（Slice 0 真机验证补）**：daemon spawn 时带 `--dangerously-skip-permissions`。headless `claude -p` 默认无人可批工具调用 → 写文件/跑命令全卡死（真机实测 workspace 空、claude 报「所有写入途径被拦截」）。授权闸已在 Pie 的 HITL 卡层过（用户批了 prompt+cwd），claude 自身的交互审批在 headless 下只会死锁，故跳过。爆炸半径靠默认隔离 cwd 控制；显式真实 cwd 时风险更高，但 cwd 卡上可见=闸。后续 slice 可让权限姿态随 target/cwd 可配

### 4.3 hand-off（交棒交互式 session）

`handoff_to_agent(context, files?)` → SW 取已检测 agent 列表 → HITL 卡（用户**选收件人 + 授权**一步完成）→ daemon 建 `~/pie-handoffs/<date>-<slug>/`，落盘 `context.md` + 产出文件 → 按所选 agent 的 launch 模式唤起交互式 session → 侧栏「已交棒 + 路径」卡。fire-and-forget，不回传。
- **收件人选择（Slice 1.5）**：target **不由 LLM 传**（工具签名无 target 参数）——被 untrusted 页面驱动的 LLM 无法诱导选收件人；用户在授权卡上从已检测列表中选（预选列表第一项），选择与授权合一步。列表为空（本机没装任何受支持 agent）→ 工具直接返回结构化错误，不弹卡。
- **Agent 注册表（Slice 1.5）**：daemon 内静态候选表（launch 命令/路径**绝不来自 wire**）+ 按需检测：CLI 用 `Bun.which`，app 用 `/Applications/Claude.app` 存在性。首批三条：`claude-app`（Claude Code (App)）/ `claude-terminal`（Claude Code (Terminal)）/ `codex-terminal`（Codex (Terminal)）；Hermes/Openclaw 等待用户提供 CLI 命令后再加——绝不凭空编 spawn 命令。新桥方法 `list_agents`（+capability，纯增量，PROTOCOL_VERSION 不动）返回 `{id,label}[]`。handoff 的 target 硬闸从 `!=="claude"` 泛化为「∈ **本次 handoff 现检测**到的 id 集」（不信任 list 时刻的旧结果）；旧 wire 值 `"claude"` 作为 `claude-terminal` 的 alias 保留（旧扩展兼容）。扩展侧对旧 daemon（无 `list_agents` capability）降级为单项列表 `[claude]`。
- **launch 模式两种**：
  - `terminal`：既有 osascript `do script` 路径（含 8 空格垫片，见下）；`start.command` 内 `exec <bin> "读 context.md 继续"`，bin 来自静态表（`claude` / `codex`）。
  - `app`（真机已验证）：`open -a Claude <dir>` → Cowork 会话根在该目录。无 prompt 注入面（深链只有 claude://claude|resume|cowork/shared-artifact）→ 目录内落 `CLAUDE.md`（写「读 context.md 继续」约定），人到场发一句即开跑。比 Terminal 稳（无 shell、无 TCC），但不自动开跑；`HandoffResult.mode` 回传，observation 明示「用户需在 app 里发一句话启动」。保留名单相应加 `claude.md`（大小写不敏感）。
- **唤起机制（Slice 1 真机验证补）**：不能用 `open start.command`——Terminal 打开 `.command` 是「spawn 交互式 login zsh + 把脚本路径当键盘输入喂进 TTY」，zsh 启动期任何 stdin 消费者（omz 升级提示 `read -k 1`）会吞掉路径首字符 → 交棒静默失败（真机实锤）。改走 AppleScript `do script`，注入串前垫 8 个牺牲空格（消费者吃到的只是空格）。代价：daemon 需一次性 TCC Automation 授权（pie → Terminal），被拒时报错并给出手动跑 `start.command` 的自救路径。`.terminal` profile 的 `RunCommandAsShell=false` 实测不被 file-open 路径尊重（仍走 zsh 打字注入），不可用。

### 4.4 skill 真执行

**能力声明（Q6，合并三字段为一个）**：
- 弃用 spec 早稿的 `capabilities.local_exec`；**扩展已有的 `capabilities.scripts`**（`package-types.ts` 现为 `string[]` 占位）为带权限形态：
  - `string` 简写 = 纯计算脚本
  - 对象形 `{ entry, fs?, network?: string[] }` = 特权脚本
- **SP-3 的 `hosts` 白名单折进 per-script `network`**；`capabilities.hosts` 字段废弃，独立 `http_request` 工具不做，**#69 被本 spec 超集，关闭并指过来**

**执行路由（一个工具，两条路径，作者/LLM 无感）**：
- `run_skill_script` → 按声明路由：无 fs/network → **MV3 sandbox（#68 机制，无需 daemon、无授权卡）**；有任何 fs/network → **daemon 执行器**
- daemon 路径：HITL（按 `skill:<id>:<permsHash>` grant，见 §6）→ 在 `~/.pie/skills/<id>/workspace/` 执行：bun subprocess、默认 60s 超时、输出 1MB 上限、fs 限 workspace、网络按域名白名单
- 结果包 `<untrusted_skill_content>` 回 observation
- daemon 未装时，带权限声明的 skill 报结构化「需要本地组件」错误

### 4.5 stdio MCP 代理

- 配置 `~/.pie/mcp.json`（Claude Desktop 格式兼容）；设置页一键导入 `~/.claude.json` / `claude_desktop_config.json`
- daemon 懒启动 server 进程 → 工具列表经桥下发 → 扩展动态注册 `mcp_<server>_<tool>` 进 tool registry
- **披露集成（Q7，方案 B）**：所有 MCP 工具归入**一个静态披露组 `mcp`**（`DisclosureGroup` enum 加一行 + `TOOL_GROUPS` 让 `mcp_*` → `mcp`）。`load_tools({groups:["mcp"]})` 一次点亮全部已连 server 工具。
  - `ponytail:` 单组无 per-server 粒度，天花板 = server 数 × 工具数的 token 面；升级路 = 方案 A（每 server 一个运行期动态组 `mcp:<server>`，`DisclosureGroup` 放宽 + 运行期注册表），**当 server 数 / token 膨胀到疼时再做**
- 调用经 §6 分级授权；结果包 `<untrusted_mcp_result>`

### 4.6 反向：本地 Agent 调 Pie（D10）

- **信任锚 = MCP 配置时**（`claude mcp add pie -- pie mcp`），**无运行期配对仪式**（与 Playwright / 本地 MCP 一致）。实际信任边界 = **socket 0600 = 用户级**（任何该用户进程可连 socket 驱动浏览器）
- 与 Playwright 的实质差异：Pie 驱动**用户真实 Chrome**（带登录态），非一次性自动化浏览器 → 爆炸半径更大 → 补**被动可见指示器 + audit log**（知情权，非闸）
- 工具面 = Pie 浏览器工具子集：`list_tabs` / `read_page` / `search_page` / `screenshot` / `act` / `navigate`（daemon 无法自执行，全部代理到扩展现有 tool 路径）
- **落点路由（Q4）**：
  - 默认落点 = 该浏览器**当前活跃 tab**（`chrome.tabs` active in lastFocusedWindow），非 Pie session 的 pinned tab；`list_tabs` 供本地 Agent 显式挑 tabId
  - 多浏览器：daemon 记录所有已连 host，`list_tabs` 跨浏览器聚合带 `browser` id；单浏览器隐式
  - 无浏览器连着：返回结构化 `no_browser_connected`
  - 冲突：目标 tab 被另一 Pie session 持 **R7 lock** → 返回 `tab_busy`，不劫持
  - 反向调用在 daemon 侧建 ephemeral **bridge session** 仅作 CDP ownerToken / sandbox 记账，操作按 tabId 直打真实 tab
- 侧栏常驻指示器（「本地 Agent 已连接」）+ 一键断开

## 5. Manifest 变更

- `nativeMessaging` 进 **`optional_permissions`**：用户开启本地打通时才请求，纯 BYOK 用户零感知

## 6. 安全模型

威胁模型变化：页面内容（untrusted）→ LLM → **本地代码执行**。

### 6.1 分级授权矩阵（Q8 定稿）

| 能力 | 授权 | 持久化 |
|------|------|--------|
| hand-off 交互式 | HITL 卡 | **不持久**（人接手终端，风险低，收益小） |
| round-trip headless | HITL 卡（prompt + cwd 原文），**每次弹** | **不持久**——风险住在每次都变的 prompt/cwd，「记住」覆盖不了危险部分，记了等于开注入洞 |
| skill script（daemon 路径） | HITL 卡（permissions 声明） | **持久**：`skill:<id>:<permsHash>`——perms 静态，一次批准合法覆盖后续；permsHash 进 key，声明一变自动失效 |
| MCP 工具 read-class | HITL 卡（按 server 首次） | **持久**：`mcp:<server>` |
| MCP 工具 write-class | HITL 卡 | **持久**：`mcp:<server>:<tool>`（写是注入主攻击面，粒度更细） |
| 反向浏览器控制 | **MCP 配置时（`claude mcp add`）** | 无运行期闸；socket 0600 边界 + 指示器 + audit |

**「记住」只对风险单元身份稳定的两类有意义**（skill 的静态 perms、MCP 的工具身份）；风险住在每次调用参数里的能力（round-trip）一律每次弹，不记。

**Invariant**：write 类本地动作无静默路径；授权卡展示的 prompt/命令一律**原文**，不经 LLM 转述。本矩阵是「工具语义即问人」的延伸，不是 risk-classifier 框架拦截的复活。

### 6.2 信任边界（wrapper）

- 新增 `untrusted_local_agent_output` / `untrusted_mcp_result`（`untrusted_skill_content` 已有）
- 按双表 invariant 登记 `UNTRUSTED_WRAPPER_TAGS`（untrusted-wrappers.ts）+ `WRAPPER_TAGS_LIST`（page-snapshot.ts）

### 6.3 daemon 侧防线（授权账本归属见 ADR 0006）

- **持久授权账本 `~/.pie/grants.json`，daemon 拥有并强制**（扩展 IndexedDB **零** grant）。强制流：agent loop 调 daemon → daemon 查账本 → miss → 回 `needs_authorization` → loop 弹 HITL 卡（扩展是唯一 UI 面）→ 批准 → loop 重调 → daemon 写 grant + 执行
- 撤销：设置页「本地」tab 经桥读 daemon 账本、列出、撤 = daemon 删条目。无时间过期，只有显式撤销 + permsHash 变更两条失效路径
- audit log `~/.pie/logs/audit.jsonl`：每个本地动作记 时间/session/命令原文/授权方式/结果
- socket 0600 仅当前用户；native host manifest `allowed_origins` 锁扩展 ID（唯一准入）
- skill 执行器：fs 限 workspace、网络域名白名单、超时、输出上限

## 7. 版本漂移（Q9）

扩展经 Chrome Web Store 自动更新、daemon 经安装包/自更新，两渠道必然错位。协议是契约，错位行为定死，杜绝「Chrome 自动更新后本地功能静默死掉」（对标 Claude Code #54567）。

- `hello` 握手带 `protocolVersion`（整数单调递增），双方各**向后兼容一个版本**；加字段只增不改语义，破坏性变更才 bump
- 漂移三档：**兼容窗口内**（差 ≤1）正常跑，缺字段走默认；**daemon 太老 / 太新**（差 >1）→ **降级到能力交集 + 不硬挂**，设置页黄条提示升级
- `pie doctor` 报双版本 + 兼容结论
- `protocolVersion` 常量在 `src/types/local-bridge.ts` 单一源，daemon 相对 import，编译期防两边不一致
- 原则：**降级不硬挂**，能力面按交集收窄 + 可见提示

## 8. 错误处理与降级

| 场景 | 行为 |
|------|------|
| daemon 未安装 | 本地类 tool **不注册**（LLM 看不到，不幻觉）；设置页安装引导 |
| 桥断连 | tool 返回结构化错误 observation；host 侧指数退避重连 |
| daemon 崩溃 | launchd KeepAlive 拉起 |
| host 崩溃 | ext onDisconnect → 重连（Chrome 重新 spawn host） |
| claude/codex 未装 | `pie doctor` 检测；`run_local_agent` 返回结构化「未检测到」 |
| 版本漂移 | §7：降级到交集，不硬挂 |

**Invariant**：扩展离开 daemon 100% 完整可用——BYOK 核心体验零依赖本地组件。

## 9. 分发、签名、自更新（D6/D9）

- **v1 macOS only**：unix socket、launchd、`.pkg`/`.dmg`
- **初次安装去终端化**：签名+公证的 `.pkg`/`.dmg`，双击安装，postinstall 注册 launchd + 写 host manifest。设置页「本地」tab 按 `navigator.platform` 给对应下载链接。curl 一行命令保留作 power-user 快捷路径
- **签名/公证 Day 1 就位**（macOS notarization）——不是后期抛光，因为自更新以它为地基
- **daemon 自更新（Slice 5）**：后台静默查 GitHub release 更新 feed（复用 `release.yml`）→ 下载签名二进制 → **验签/验公证** → 原子替换 → 重启（Sparkle/Squirrel 模型）；叠一层浏览器内「立即更新 daemon」一键（`hello` 检测偏旧时）
  - **安全 invariant**：替换前必须验证下载二进制签名/公证——不验证的自更新 = RCE 后门。更新只从签名 feed + HTTPS 来
- 早期（Slice 0–4）：靠一键下载安装包 + §7 降级过渡，自更新未就位

## 10. 仓库、CI、测试

- 主仓库 `daemon/` 子目录，独立 package.json（bun）；协议类型 import `src/types/local-bridge.ts`，**不复制**
- CI：daemon job（bun test + macOS 二进制 artifact）
- release workflow：扩展 zip + macOS 二进制 + `.pkg` 同 release
- 测试：协议层（framing/分块/JSON-RPC 路由）纯函数单测两侧共享；daemon 集成 bun test（真 daemon + fake socket client）；扩展侧 vitest mock `chrome.runtime.connectNative`；真机手测清单（安装、六能力面、断连恢复、版本漂移降级、双浏览器并连）

## 11. 非目标

- 不做裸 localhost WebSocket / token 配对（D7）
- 不做运行期配对仪式（D10：MCP 配置时即授权）
- 不做 remote MCP（streamable HTTP 直连扩展可独立做，不在本 spec）
- daemon 不做通用 shell 执行工具（只有 4.1–4.3 三条受控路径能 spawn 进程）
- 不复活 risk-classifier 式框架拦截
- 纯计算 skill 脚本不进 daemon（走 #68）
- **v1 不做 Windows / Linux**（D9）
- **不做托盘/菜单栏 GUI 壳**（D6，headless；若需常驻可见性后议）
- MCP 披露不做 per-server 粒度（Q7 方案 A，defer）

## 12. 实现期 spike（非设计 TBD，plan 阶段先做）

1. bun compile 产物作 native messaging host 的 stdio framing 兼容性（1MB 上限、大消息分块、背压）——Slice 0 第一步 spike
2. `codex exec --json` 输出格式稳定性（Codex CLI 迭代快，runner 做 per-target adapter）
3. macOS `.pkg` postinstall 注册 launchd + 写 host manifest 的权限/路径细节
