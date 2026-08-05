# Daemon Windows 适配（Pie Link Windows 版）— Spec

- 日期：2026-08-05
- 状态：定稿（grilling 质询完成，逐项拍板）
- 上游：issue #268（daemon Windows 适配）；依赖 #267（制品化）已随 v1.2.0 落地
- 前置调研：2026-08-05 三路业界调研（srt 官方进展 / 同类 CLI 横评 / Windows 原生机制横评），结论见下"背景"

## 0. 背景与前提修正

#268 立项时的硬风险是"srt（@anthropic-ai/sandbox-runtime）没有 Windows 沙箱实现"。**该前提已过时**：srt（真实仓库 `anthropic-experimental/sandbox-runtime`）自 2026-05 起已实现并随 npm 发布 **Windows 原生后端（官方标注 alpha）**：

- 捆绑 `srt-win.exe`（Rust，x64 + arm64 随 npm 分发，零额外依赖）；
- 机制 = 专用本地账户 `srt-sandbox` + restricted token + job object + 机器级 WFP 按 SID 断网（loopback 代理端口段豁免）+ NTFS 增量显式 ACE；域名白名单代理与 mac/Linux 共用同一套 JS 层；
- 需一次性 UAC 提权安装（`windows-install`，幂等，有编程接口 `installWindowsSandbox()` / `uninstallWindowsSandbox()`）；
- 配置 schema 三平台统一（`filesystem.allowWrite/denyRead` + `network.allowedDomains`），与我们 `SkillSandbox` 接口的三项 policy 一一对应。

业界横评（2026-08）：Windows 原生沙箱收敛为三流派——① restricted token 派（Codex unelevated、Gemini CLI）免 admin 但断不了网/挡不住读；② **专用账户 + WFP + ACL 派（Codex elevated、srt-win）**，一次 UAC 换强隔离，最强纯用户态方案；③ microsoft/mxc（MIT，Copilot CLI 底层），Win11 25H2+ 有全新 OS 原语 `Experimental_CreateProcessInSandbox`，srt 有 open PR（#427）计划自动选用 MXC——押 srt 未来大概率白拿这条路径。硬约束：**WFP 加过滤器必须 admin**，故要保住 `allowedDomains` 语义（默认断网 + 白名单走 loopback 代理），一次性 UAC 绕不开。

已知风险（真实、需 Gate 管控）：srt-win 是 alpha，**Claude Code 产品自身尚未在原生 Windows 启用它**（官方文档仍推 WSL2）；有 open 的 ACL 绕过报告（srt#402：目标路径带 Authenticated Users 修改权时 allowWrite 外也能写）；独立账户模型使 **per-user 安装的工具链（Scoop/nvm/`pip --user`/%LOCALAPPDATA% 下的 Python）在沙箱内不可见**；schannel 系工具的证书吊销检查会撞网络围栏。

**结论（已拍板）：方案 A——继续押 srt，Windows 沙箱后端 = srt-win alpha，以 Gate 0 spike 管控稳定性风险。不自研、不 WSL2、不 Sandboxie、不 WSB。**

## 1. 已定决策总表

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 范围 | #268 全量 Windows 适配（沙箱为核心章节，pipe/注册表/常驻/安装器/paths/托盘一并定案） |
| 2 | 支持面 | Windows 10 22H2+ / Windows 11，**x64 only**；arm64 设备靠系统 x64 模拟层（spike 验证，不行则明确不支持） |
| 3 | 稳定性 | **双路径 + Gate 0**：spec 即定稿；Gate 过 → 完整方案；Gate 不过 → 降级交付（无脚本执行，fail-closed） |
| 4 | UAC 时机 | 安装器内一次 UAC，内部调 `installWindowsSandbox()`；沙箱设施失败**不阻断安装**，只降级脚本执行 |
| 5 | 常驻方式 | HKCU Run key 登录自启 + host 兜底拉起（崩溃自愈）；不用服务、不用计划任务 |
| 6 | 托盘 app | **首期就做最小托盘**（对齐 mac 顶栏体验：图标 = 装成功/连接状态，菜单收敛版） |
| 7 | 安装器 | Inno Setup，CI 每 tag 自动构建（对齐 mac build-pkg.sh 流程） |
| 8 | 脚本语言 | `.ts/.js/.mjs` 必保（pie.exe 内嵌 Bun）+ `.py` 尽力（探测全局 python）+ `.sh` 明确不支持 |
| 9 | 代码签名 | 首期不签（接受 SmartScreen 摩擦），CI 留签名步骤占位；签名跟 #267 演进另行推进 |
| 10 | 分工 | 本地 session 备 spike 材料 → 用户 Windows 真机跑 Gate 0 → 过 Gate 后拆 issue 交云端 Loop 实现 → need-human-test 用户真机验收 |

## 2. Gate 0 spike（实现前置闸）

**目的**：用最小成本验证 srt-win alpha 在我们的形态（`bun build --compile` 单二进制 daemon）里端到端可用。**Gate 不过不排实现期**，走 §8 降级路径。

### 2.1 spike 材料（本地准备）

1. 升级 `daemon/package.json` 的 `@anthropic-ai/sandbox-runtime` 至最新（当前 pin 0.0.64，Windows 修复密集持续到 0.0.67+），**重新精确 pin**；升级后先跑 macOS 回归（现有 skill 脚本沙箱验收，playwright harness + 手测），确认 mac 路径不被 alpha 演进破坏。
2. 交叉编译 `pie.exe`（`bun build --compile --target=bun-windows-x64`），连同 srt 的 `vendor/srt-win` 二进制打成 spike 包。
3. spike 验证脚本 + 逐项清单（PowerShell 驱动，输出逐项 PASS/FAIL）。

### 2.2 Windows 真机验证清单（用户执行）

| 项 | 验证内容 | 通过标准 |
|---|---|---|
| S1 | `windows-install` 一次 UAC 安装沙箱设施 | 装成、幂等重跑不炸、`srt-sandbox` 账户与 WFP 规则就位 |
| S2 | **写限**：脚本写 workspace 内成功、workspace 外失败 | 白名单语义与 mac 一致 |
| S3 | **断网**：`allowedDomains: []` 时出站全挂 | fail-closed |
| S4 | **域名白名单**：仅放行域可达，其余拒 | 代理白名单语义与 mac 一致 |
| S5 | **敏感读拒**：`denyRead`（`.ssh` 等）读取失败 | 与 mac baselineDenyRead 一致 |
| S6 | `.ts` 脚本经 pie.exe 自身解释执行（沙箱内） | 内嵌 Bun 路径在沙箱账户下可执行（注意：pie.exe 装机位置须对 `srt-sandbox` 账户可读——装 Program Files 天然满足） |
| S7 | 全局安装的 python 在沙箱内可用；per-user Python 的失败形态 | 失败信息可辨识（供引导文案用） |
| S8 | Bun named pipe：`\\.\pipe\` 上 listen/connect（daemon↔host） | 双向可通，断开语义可检测 |
| S9 | arm64 设备 x64 模拟层跑 pie.exe + srt-win（如有设备，可选） | 可行则 arm64 按模拟支持，不可行则明确不支持 |
| S10 | 卸载：`windows-uninstall` 清账户/WFP/ACE | 无残留 |

### 2.3 Gate 判定

- **过**（S1–S6、S8 全绿；S7 失败形态可接受）：按 §3–§7 完整方案拆 issue 实现。
- **不过**（核心项挂且无法在 srt 侧短期解决）：走 §8 降级首期，沙箱等 srt 稳定 / MXC（srt#427）落地再补，#268 留尾巴 issue 跟踪。
- spike 中记录 srt 版本与行为细节（尤其 `windows.srtWin.path` 是否必填——v0.0.67 release notes 与 README 表述有出入，以实测为准），回填本 spec。

### 2.4 Gate 0 实测结论（2026-08-06，已通过）

**判定：通过，走完整方案（§3–§7）。** 环境：Windows 11 ARM64（Parallels VM）+ x64 模拟层——S9 顺带全链路覆盖。S1–S10 全绿：install/幂等、写限、断网、域名白名单（CONNECT 403 语义）、敏感读拒、内嵌 Bun 沙箱内执行、named pipe、uninstall 清理彻底（egress probe 转报 no credential）。

实测发现（编号供实现 issue 引用）：

| # | 发现 | 对实现的要求 |
|---|---|---|
| F1 | `srt-win.exe` 动态链接 `VCRUNTIME140.dll`，干净机器上 loader 阶段静默死（STATUS_DLL_NOT_FOUND，0xC0000135），零输出零 UAC | 安装器必须捆绑 `vc_redist.x64.exe` 静默安装（Inno `[Run]` `/install /quiet /norestart`）；并行推动上游静态 CRT（Rust `+crt-static`） |
| F2 | Bun spawn 把 Windows NTSTATUS 退出码截断为低 8 位（0xC0000135 → 53），srt JS 层错误分类随之失真 | daemon 调 srt-win 的错误路径要意识到退出码可能是截断值；诊断时用低 8 位反推 NTSTATUS |
| F3 | broker 进程的自定义 env **不穿透**沙箱进程（`CreateProcessWithLogonW` 换账户，实测 `PROBE=%VAR%` 原样回显） | skill-exec Windows 分支的 `BUN_BE_BUN`/`PIE_SKILL_DIR`/`PIE_WORKSPACE` 注入改走 cmd 内联 `set "K=V" && ...` 链（S6b 已验证可行） |
| F4 | `where python` 常命中 `\WindowsApps\` 的 Store 执行别名 stub（per-user reparse point），沙箱账户必然拒绝访问 | python 探测排除 `\WindowsApps\` 路径；排除后无候选 = 按无 python 处理 |
| F5 | exe 位于网络路径（UNC / 映射盘 / VM 共享文件夹，含 Parallels 重定向的桌面 `C:\Mac\...`）时，提权进程找不到自身 → ERROR_BAD_NETPATH(53) | 安装器装 `Program Files`（本地盘）天然规避；`pie doctor` 补"安装路径是否网络位置"检查 |
| F6 | 非管理员枚举 BFE filter 必然 `cannot-read`（0x5，预期行为） | 就绪检查一律用 `verifyWindowsWfpEgress` 行为探针（BLOCKED=围栏在位），不看 filter 枚举 |

## 3. 沙箱设计（核心章节）

### 3.1 接口不变量

`daemon/src/skill-sandbox.ts` 的 `SkillSandbox` 接口（`run(argv, cwd, env, settings)`，settings = `allowWrite/allowedDomains/denyRead`）**保持不变**，上层编排（skill-exec、grant 信封、audit、workspace 隔离）零改动。Windows 差异全部封装在 `runViaSrt` 的平台分支内：

- **命令组装**：现有 `shellQuote` 是 POSIX 单引号语义，Windows 分支按 srt-win 的 `wrapWithSandboxArgv` 实际契约组装（srt-win 对 Git Bash 有一等 inner shell 支持，但我们首期不依赖它——`.sh` 不支持，`.ts/.py` 走直接 argv；具体形式以 spike 实测为准）。
- **串行化、超时（60s）、输出封顶（1 MB）、双管排空**：语义与 mac 一致，机制复用。
- **异步 spawn 铁律**（绝不 `spawnSync`，srt 进程内 JS 代理依赖事件循环）三平台同样成立。

### 3.2 沙箱设施生命周期

- **安装**：Inno 安装器提权阶段调 `installWindowsSandbox()`（建 `srt-sandbox` 账户、组、WFP 基础设施、state.db）。幂等：升级重装重跑即 reconcile。
- **失败降级（fail-closed）**：设施安装失败/被用户跳过/运行期检测不可用 → daemon 照常工作（桥接/skills/handoff 全可用），仅 `run_skill_script` 返回明确错误（"Windows 脚本沙箱未就绪"+引导重装）；`pie doctor` 增加沙箱设施检测项；扩展设置页「本地打通」透出该状态。**裸跑永不发生**（既有默认沙箱 invariant）。
- **卸载**：Inno 卸载器调 `uninstallWindowsSandbox()`。

### 3.3 风险登记（接受 + 缓解）

| 风险 | 处置 |
|---|---|
| srt-win alpha 演进快、API 可能 breaking | srt **精确 pin**；升级须过 mac 回归 + Windows 验收双关；`SkillSandbox` 抽象层保证换后端不动编排 |
| ACL 绕过（srt#402） | 接受（威胁模型：防的是不受信 skill 脚本越权，非防恶意本地攻击者）；跟踪上游修复 |
| per-user 工具链沙箱内不可见 | 产品化引导：skill 作者文档明示"跨平台脚本首选 ts"；`.py` 探测失败时报错文案引导全局安装 Python（勾 "Install for all users"） |
| schannel CRL 撞围栏 | 接受（上游已列 planned 修复：loopback CRL 分发点）；受影响面为沙箱内 schannel 系工具的 TLS，`.ts` 脚本走 Bun fetch 不受影响 |
| Claude Code 自身未启用 srt-win（成熟度信号） | 即 Gate 0 存在的理由；Gate 实测定生死，不赌 |

### 3.4 未来路径（不进首期）

MXC BaseContainer（Win11 25H2+，免 UAC 免账户）：srt PR #427 合入后，升级 srt 即可能自动获得；届时可评估把"一次 UAC"从安装器移除（25H2+ 用户零提权）。本 spec 不为其预留代码，仅记录方向。

## 4. 平台工程

### 4.1 IPC：unix socket → named pipe

- daemon listen `\\.\pipe\ai.wiseria.pie`（Bun/Node net 兼容层，S8 spike 验证）；host 连接同名 pipe。
- `src/types/local-bridge.ts` wire 协议**零改动**（PROTOCOL_VERSION 不动，纯传输层替换）；`daemon/src/paths.ts` 增加平台分支给出 socket/pipe 地址。
- named pipe 无文件系统残留，mac 侧 socket 文件清理逻辑在 Windows 分支为 no-op。

### 4.2 Native messaging manifest：注册表

- 写 `HKCU\Software\Google\Chrome\NativeMessagingHosts\ai.wiseria.pie`（默认值 = manifest json 绝对路径），manifest json 落盘 `%LOCALAPPDATA%\PieLink\`。HKCU 不需要 admin，但既然安装器已提权，一并写入。
- Edge 对应键（`HKCU\Software\Microsoft\Edge\NativeMessagingHosts`）一并写（mac 侧已支持 Edge 分发，零成本对齐）。
- host 形态：Windows native messaging 直接指到 `pie.exe host` 不行（manifest 只接一个可执行路径 + 无参数限制——实际 Chrome 允许 manifest path 指 .exe，参数不可带），故装一个 `pie-host.exe` 薄 wrapper 或用 `pie-host.bat`；**取 wrapper exe**（bat 会闪 cmd 窗口）。实现可以是同一 pie.exe 按 argv[0] 名字分派（复制/硬链一份改名），避免第二个二进制源。

### 4.3 路径抽象

- `daemon/src/paths.ts`：`~/.pie` → `%USERPROFILE%\.pie`（保持点目录风格，与 mac 语义一致：sessions/skills/grants.json/logs 结构不变）。
- 双根副根：`~/.agents/skills` → `%USERPROFILE%\.agents\skills`，遮蔽/CoW/read_only 语义不变。
- `safeRelPath` 等路径守卫补 Windows 语义（反斜杠、盘符、UNC 前缀），workspace 锁定不变量不放松。

### 4.4 常驻与拉起

- 安装器写 `HKCU\...\Run` key：登录启动 `pie.exe daemon`（无窗口方式，spike 确认 Bun 编译产物的窗口行为，必要时经托盘 exe 代启）。
- **host 兜底拉起**：host 启动时连 pipe 失败 → spawn detached `pie.exe daemon` → 退避重连（复用扩展侧既有 1s→30s 梯子语义）。这补上 launchd KeepAlive 的崩溃自愈缺口。
- 并发保护：daemon 启动时抢 pipe，占用即退出（单实例语义与 mac socket 一致）。

### 4.5 安装器（Inno Setup）与 CI

- 安装内容：`pie.exe` + `pie-host.exe` + 托盘 exe + srt vendor（srt-win.exe）+ `vc_redist.x64.exe` 静默前置（F1）→ `%ProgramFiles%\Pie Link\`；[Registry] 段写 native messaging 键 + Run key；[Run] 段调 `installWindowsSandbox()`（容错：失败仅记录，见 §3.2）+ 启动托盘；卸载段逆操作 + `uninstallWindowsSandbox()`。
- CI：release workflow 增加 windows job（或复用 macOS job 交叉编译 + windows runner 跑 iscc），每 tag 产 `pie-link-setup-<version>.exe` 上传 release asset；版本与 daemon/package.json 一致（沿用既有 daemon 版本机制：实质改动 bump version，wire 破坏才 bump PROTOCOL_VERSION）。
- 签名：CI 留签名步骤占位（拿到证书填 secrets 即生效），首期跳过；README/官网写清 SmartScreen 引导（"更多信息 → 仍要运行"）。

### 4.6 最小托盘 app

- 范围：图标（连接/未连接两态即可，对齐 mac 顶栏 PieFace 的收敛版）+ 菜单：状态行、打开日志目录、退出 daemon。**不做**mac 顶栏 app 的完整菜单面。
- 技术栈：C# 编译到 .NET Framework 4.8 单 exe（Win10/11 系统自带 runtime，零额外分发依赖；CI windows runner 自带编译器）。与 daemon 通信复用 status RPC（连 named pipe）。
- 登录自启由 Run key 统一管（托盘 exe 拉 daemon 或反之，实现期定，倾向：Run key 起托盘、托盘保 daemon，对齐 mac"图标出现 = 一切就绪"）。

### 4.7 handoff / agents 检测 Windows 化

- PATH 来源：Windows 无 login shell 概念，直接读进程 env PATH + 注册表 user/system PATH 合并；`where` 解析绝对路径（对齐 mac"detect 解出绝对路径、start.command exec 绝对路径"的既有约定）。
- 候选表：**命令必须 Windows 真机验证过才进表**（既有铁律）。首期候选 = Claude/Codex/Cursor 的 terminal 形态（Windows Terminal `wt` / 回落 `cmd start`）+ 各家 Windows app 形态里真机验证可行者；mac 8 条候选不平移，Windows 表从零验证起。
- 该块随实现期由验收逐条点亮，spec 不预设清单。

### 4.8 脚本解释器 Windows 化

`interpreterFor`（skill-exec.ts）平台分支：

- `.ts/.js/.mjs` → pie.exe 自身（不变，必保路径）；
- `.py` → 探测全局 `python`（`where python` + 版本 sanity；探测不到或仅 per-user → 明确错误 + 引导全局安装）；
- `.sh` → Windows 上直接报"不支持"（错误信息建议作者提供 ts 版本）。
- `docs/agents/skill-authoring.md` 同步：跨平台 skill 脚本首选 ts；py 依赖全局安装；sh 视为 mac/Linux 专属。

## 5. Non-goals（首期明确不做）

- 原生 arm64 构建（等 Bun windows-arm64；模拟层可行即覆盖）
- Linux 适配（#268 既定后置）
- 代码签名（留接口，另行推进）
- MSI/企业分发、GPO 支持
- WSL2 路径、MXC 直接集成（未来经 srt 白拿）
- `.sh` 脚本支持、Git Bash 依赖
- Windows 侧完整顶栏菜单面（对齐 mac S5 全功能）、日志查看页

## 6. 开放问题（spike 回填）

1. ~~`windows.srtWin.path` 必填与否~~ **已定（2026-08-05 读 v0.0.67 d.ts 实锤）**：必填，无隐式 vendored 回落（"Omitting it throws (there is no implicit vendor fallback)"）。且 bun compile 单二进制内 `__dirname` 相对解析失效——产品实现须把 `srt-win.exe` 作为安装器伴随文件分发（放 Program Files，天然在写 grant 外，符合上游"binary outside any grant"的安全告诫），运行时显式传 `windows.srtWin.path`。spike 程序已按此实现。
2. Bun 编译产物做无窗口后台进程的正确姿势（`-mwindows` 等价物 / 托盘代启）→ spike 未专门验证，留给实现期（常驻片）实测。
3. ~~arm64 模拟层可行性~~ **已定（Gate 0 实测）**：可行——整个 spike 在 ARM64 Win11 的 x64 模拟层上全链路跑通（含 srt-win 提权链、WFP、内嵌 Bun）。arm64 设备按模拟层支持。
4. ~~srt 升级对 mac 现网的回归面~~ **已定**：0.0.64→0.0.67 精确 pin 后 daemon 166 测试全绿。

## 7. 验收（用户 Windows 真机，need-human-test 清单基线）

1. 安装器全流程：下载 → SmartScreen 引导 → 一次 UAC → 完成页 → 托盘图标出现。
2. Chrome 扩展「本地打通」自动连接（对齐 mac 首连体验，含 skills 导入向导）。
3. skill 磁盘真源 CRUD（`%USERPROFILE%\.pie\skills`）+ 副根 `~\.agents\skills` 遮蔽/只读语义。
4. `.ts` skill 脚本沙箱执行全链路：授权卡 → 执行 → outputs 清单 → `read_skill_output`；越权写/出网被拒。
5. 沙箱设施缺失时的降级行为：`run_skill_script` 明确报错、doctor 检测、设置页状态。
6. handoff：已验证候选逐条真机点亮。
7. daemon 崩溃自愈：杀进程 → 扩展重连触发 host 兜底拉起。
8. 卸载：残留检查（账户/WFP/注册表/文件）。
9. 升级重装：幂等、配置/grants/skills 保留。

## 8. 降级首期（Gate 0 不过时的交付形态）

桥接（named pipe + native messaging）+ skills 磁盘真源 + handoff/agents 检测 + 托盘 + 安装器（不含沙箱设施步骤），`run_skill_script` 明确报"Windows 暂不支持脚本执行"。§4 全部适用，§3 整章挂起为跟踪 issue，等 srt 稳定或 MXC 落地重启。

## 9. 交付切片（过 Gate 后拆 issue 的建议骨架）

1. paths/pipe/守卫 Windows 分支（纯代码，可云端，vitest 覆盖）
2. skill-sandbox / skill-exec Windows 分支（srt-win 集成 + 解释器表）
3. host 兜底拉起 + 单实例
4. 托盘 app（C#）
5. Inno 安装器 + 注册表 + CI windows job
6. handoff 候选表 Windows 化（真机逐条验证）
7. 文档批：skill-authoring / README 安装引导 / doctor
   （每片按 triage 惯例打 `ready-for-implement`，需真机的片走 `need-human-test`）
