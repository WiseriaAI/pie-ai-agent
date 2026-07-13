# 适配更多本地 Agent（#269）

> grilling 定稿 · 2026-07-14 · 状态：设计完成，待落 issue → 交云端实现
>
> 前置 issue：#269（need-design）。本 spec 取代 issue body 里的原始设计议题。

## 1. 结论摘要

handoff（交棒）候选表从 3 条扩到 8 条，覆盖 Claude / Codex / Cursor / OpenCode / Pi 五家。
表结构做三处最小改动（argv 模板、appPaths、convention），**wire 协议与扩展侧零改动**。

同时修掉一个 grilling 过程中挖出的、**main 上已存在的地基 bug**：daemon 跑在 launchd 的裸 PATH
下，`Bun.which()` 看不到任何 agent CLI —— 今天真机上 terminal 形态（`claude-terminal` /
`codex-terminal`）**一条都检测不到**，HandoffCard 上只会出现 "Claude Code (App)"。不修这条，
本 issue 新增的 4 个 terminal agent 全部是死的。

## 2. 候选表终稿

| id | label | kind | 检测 | 启动 | convention |
|---|---|---|---|---|---|
| `claude-app` | Claude Code (App) | app | `/Applications/Claude.app` | `open -a <path> <dir>` | CLAUDE.md |
| `claude-terminal` | Claude Code (Terminal) | terminal | `which claude` | `["{prompt}"]` | — |
| `codex-app` | Codex / ChatGPT (App) | app | `/Applications/Codex.app` → `/Applications/ChatGPT.app` | `open -a <path> <dir>` | AGENTS.md |
| `codex-terminal` | Codex (Terminal) | terminal | `which codex` | `["{prompt}"]` | — |
| `cursor-app` | Cursor (App) | app | `/Applications/Cursor.app` | `open -a <path> <dir>` | AGENTS.md |
| `cursor-terminal` | Cursor (Terminal) | terminal | `which cursor-agent` | `["{prompt}"]` | — |
| `opencode-terminal` | OpenCode (Terminal) | terminal | `which opencode` | `["--prompt", "{prompt}"]` | — |
| `pi-terminal` | Pi (Terminal) | terminal | `which pi` | `["{prompt}"]` | — |

表顺序 = HandoffCard 预选顺序（品牌分组，每组 app 在前）。

**被砍掉的候选**：

- **Hermes** —— `-z/--oneshot` 是 headless 打印即退，交互式入口 `hermes chat` 的 `-q` 同样是
  非交互单次查询。**没有"开交互会话 + 自动带初始 prompt"的形态**，交棒后人还得自己发一句，
  价值打折且要为它单独引入一条"起得来但开不了跑"的退化路径。砍。
- **Openclaw** —— gateway/daemon 架构（`openclaw agent` = "Run one agent turn via the Gateway"，
  要先有 gateway 在跑），与 `start.command` 的 exec 范式不同构。往后放。

## 3. 表结构改动（三处）

```ts
export interface AgentCandidate {
  id: "claude-app" | "claude-terminal" | "codex-app" | "codex-terminal"
    | "cursor-app" | "cursor-terminal" | "opencode-terminal" | "pi-terminal";
  label: string;
  kind: "app" | "terminal";

  /** terminal：检测用的 bin 名 */
  bin?: string;
  /** terminal：argv 模板，"{prompt}" 占位。位置参数 vs flag 的差异只是数据。 */
  argv?: string[];

  /** app：按优先级探路径，命中第一个存在的；spawn 用命中的绝对路径。 */
  appPaths?: string[];
  /** app：目录内的约定引导文件名（app 无 prompt 注入面，靠它引导）。 */
  convention?: "CLAUDE.md" | "AGENTS.md";
}
```

1. **`argv: string[]`（新增）** —— `claude` / `codex` / `cursor-agent` / `pi` 是位置参数
   `["{prompt}"]`，`opencode` 是 `["--prompt", "{prompt}"]`。差异用数据表达，daemon 里零 if 分支。
2. **`appPath` + `appName` → `appPaths: string[]`（合并）** —— Codex 与 ChatGPT app 已合并为同一
   bundle（`com.openai.codex`，本机 `/Applications/ChatGPT.app` 的 bundle id 即为此），需要按优先级
   探两条路径。spawn 改用 `open -a <命中的绝对路径> <dir>`，app 再改名也不受影响，`appName` 字段消失。
3. **`convention`（新增）** —— app 模式写哪个引导文件：Claude 系写 `CLAUDE.md`，Codex / Cursor 写
   `AGENTS.md`（AGENTS.md 是 2026 的开放标准，Codex / Cursor / Copilot / Gemini / Aider / Zed 原生读）。
   配套：`handoff.ts` 的 `RESERVED` 名单加 `agents.md`，防 LLM stage 的文件撞名覆盖引导文件。

**wire 不动**：砍掉 hermes 后，terminal 形态全部能自动开跑、app 形态全部需人发一句，
`HandoffResult.mode`（`"app"` / `"terminal"`）的现有语义继续成立，不需要新增 `autostarted` 字段。
`PROTOCOL_VERSION` 保持 1。

## 4. 地基修复：daemon 的 PATH（必须并入本 issue）

### 病灶

daemon 由 launchd 起（`~/Library/LaunchAgents/ai.wiseria.pie.plist`，`RunAtLoad`/`KeepAlive`），
中间没有任何 shell 参与 —— `.zshrc` / `.zprofile` / `path_helper` 一行都不会被读。plist 里也没有
`EnvironmentVariables`，`launchctl getenv PATH` 为空，于是 launchd 给出编译进去的 BSD 默认值：

```
# 运行中的 daemon（pid 14574）实测
PATH=/usr/bin:/bin:/usr/sbin:/sbin
```

在这个 PATH 下 `Bun.which()` 的结果：`claude` / `codex` / `cursor-agent` / `opencode` / `pi`
**全部 NOT FOUND**。这就是"从 Dock 启动的 GUI app 找不到 node/brew"的经典 macOS 坑。

Slice 1.5 的真机验收之所以通过，是因为验的是 app 形态（`existsSync` 不看 PATH）。
**terminal 那条腿从引入 detect 闸起就一直是瞎的，没人发现。**

同一个根因的第二个症状：`start.command` 里 `exec opencode`（裸命令名）依赖运行时 PATH，
真机实测报 `exec: opencode: not found`。

### 修法

`detectAgents()` 里问用户自己的 login shell 要 PATH（VS Code 的 shell-env 同款做法），
用它做 `which` 拿到**绝对路径**，`start.command` 里 exec 绝对路径：

```ts
// daemon/src/agents.ts
function getUserPath(): string {
  // launchd 给的是裸 PATH，看不见任何 agent CLI。问用户的 login shell 要真相。
  // stdin 关掉：防 zsh 启动期读 stdin 的东西（omz 升级提示的 read -k）挂死探测
  //   —— 与 handoff.ts 的 LAUNCH_PAD 是同一个坑。
  // 超时 3s 兜底：rc 重度定制的用户可能要一两秒；超时回落 process.env.PATH，
  //   宁可检测不到也不能卡住授权卡。
  const r = Bun.spawnSync([process.env.SHELL ?? "/bin/zsh", "-lic", "echo $PATH"],
                          { stdin: "ignore", timeout: 3000 });
  return r.stdout.toString().trim().split("\n").pop() || process.env.PATH || "";
}
const abs = Bun.which(c.bin, { PATH: getUserPath() });  // → /Users/x/.opencode/bin/opencode
```

```
# daemon/src/handoff.ts —— start.command 里 exec 绝对路径，不再是裸命令名
exec /Users/x/.opencode/bin/opencode --prompt "Read context.md …"
```

**不缓存，每次 detect 现探**。实测代价 0.10–0.16s，在"LLM 调工具 → 弹授权卡"和"打开设置页"
这两个调用点上无感。好处是不需要缓存失效策略、不需要"刷新"按钮、不需要重启 daemon：
用户装完新 agent，重开设置页或下次 handoff 就看得到。

影响面：**daemon 两个文件**（`agents.ts` / `handoff.ts`）。扩展侧、wire、plist、安装脚本零改动。

## 5. 真机验证结果（2026-07-14，验证先行，命令验过才进表）

全部走 daemon 完全同款的路径：写 `context.md`（+ app 模式的引导文件）→ `start.command` →
`osascript do script`（含 `LAUNCH_PAD` 牺牲空格）/ `open -a <path> <dir>`。

| 候选 | 结果 |
|---|---|
| `cursor-terminal` | ✅ 自动开跑，读到 context.md，产出 `PROOF.txt = HANDOFF-OK` |
| `pi-terminal` | ✅ 自动开跑，prompt 正确注入（未登录 → `401 User not found`，触发链路完整） |
| `opencode-terminal` | ❌ 裸命令名 → `exec: opencode: not found`；✅ **换绝对路径后 TUI 起来、prompt 自动发送**（未登录 → `User not found.`） |
| `claude-terminal` | ✅ 绝对路径版自动开跑，读到 context.md，停在**交互审批**等人按 y —— 正是 handoff 不带 `--dangerously-skip-permissions` 的设计意图（人就在终端前） |
| `codex-terminal` | ✅ 绝对路径版自动开跑，产出 `PROOF.txt = HANDOFF-OK` |
| `codex-app`（ChatGPT.app） | ✅ 目录作为「项目」打开，输入框上方挂着该目录 chip，等人发一句 |
| `cursor-app` | ✅ 目录作为工作区打开，`AGENTS.md` + `context.md` 在文件树里，agent 面板就绪 |

关键实证：**`opencode --prompt` 是自动发送的**（不是只预填输入框），所以它和位置参数那四家一样
属于"自动开跑"，`mode: "terminal"` 语义成立。

## 6. Cursor App 的语义（已知取舍）

Cursor 是 IDE，`open -a Cursor <handoff dir>` 打开的是一个**只有 context.md + AGENTS.md 的空工作区**
（用户真正的项目仓库不在里面）。这是明确接受的取舍：交棒目录本来就是一次性任务工作区，
用户在 IDE 里 `⌘L` 发一句 "continue"，agent 读 AGENTS.md → context.md 继续。

若要让 IDE 类 app 打开**真实项目目录**，需要给 handoff 加可选的项目 cwd（`run_local_agent` 已有
`cwd` 参数，handoff 没有）——那是 handoff 的目录模型问题，**单开 issue，不在本轮**。

## 7. 不在本轮范围

- **`run_local_agent` 的 headless 后端仍硬编码 `claude`**（`daemon/src/run-local-agent.ts:41`）。
  只装了 Cursor / Codex 而没装 claude 的用户，这个工具是死的。**单开 bug issue**，本轮不碰：
  并进来会让验证矩阵从 8 条翻倍到 13 条，且 headless 的验证更贵（要真跑一次带工具调用的任务才知道
  `--force` / `--dangerously-skip-permissions` 管不管用、输出能不能直接当 observation）。
  各家 headless 契约已查实，留给那个 issue：`claude -p --dangerously-skip-permissions` /
  `codex exec` / `cursor-agent -p --force` / `opencode run --auto` / `pi -p`。
- **用户自定义 agent 条目**（设置页填命令模板）—— 投机需求，还没有任何用户说过"我用的 agent 不在表里"。
  静态表加行的边际成本是"一行 + 一次真机验证"。真到长尾追不动了再开，届时静态表正好是它的默认值。
- **MRU 预选记忆** —— 设置页的 `enabled_local_agents` 开关已经是收窄机制（关掉不用的 agent，
  列表就只剩自己那一两个）。MRU 是第二套解决同一问题的机制，残余痛点只是"多点一次鼠标"。
（图标原定只做 Cursor，但三家的 SVG 资产用户已备齐，边际成本降为三个分支 —— 见附录 A，本轮全做。）

## 8. 已知行为 / 限制

- **动过设置页开关的老用户**（`enabled_local_agents` 落了显式数组），升级后新 agent **默认关闭**，
  需去设置页手动打开。没动过开关的用户（`null` 偏好 = 已装全启用）自动获得。保守正确，不改。
- **agent 装进全新目录并改了 shell rc**（如 opencode 的 `~/.opencode/bin`）时，daemon 需重启才能发现
  —— 因为它探的是 login shell 的 PATH，而那个 PATH 变了。这与用户"得重开一个终端才生效"是同一语义。
  （装进 PATH 里已有的目录 —— `~/.local/bin`、`/opt/homebrew/bin` 这些绝大多数情况 —— 立刻可见。）
- **app 装在非 `/Applications`**（`~/Applications`、Setapp）会漏检。macOS 桌面 app 99% 在
  `/Applications`；真有人反馈就是表里加一行路径。（bundle id 是唯一权威，但 Launch Services 查询
  实测冷启动 **16 秒**，坐在授权卡热路径上不可接受；mdfind 快但把检测押在 Spotlight 索引上，
  索引没建完就静默漏检，比慢更糟。）

## 9. 交付

**单 issue 单 PR**：地基（PATH 修复）+ 表结构三改 + 8 条候选 + Cursor 图标 + `RESERVED` 补 `agents.md`，
真机清单一次跑完。

不按 agent 拆 5 个 issue —— 那是切在数据上不是切在能力上：表结构是共享地基，5 条新 agent 只是地基上的
数据行（每条 3 行），拆开会让 5 个 Loop 改同一张表 → 冲突 + 5 轮 review + 5 轮真机。

**真机验收清单（need-human-test）**：

1. daemon 重启后打开设置页「本地打通」，8 条候选中已安装的**全部出现**（重点：terminal 形态不再是瞎的）
2. HandoffCard 列出已安装 ∩ 已启用的 agent，预选第一项
3. 交棒到每个已装 terminal agent：终端弹出、agent 自动开跑、读到 context.md
4. 交棒到 Claude.app / Codex(ChatGPT).app / Cursor.app：目录作为工作区打开，引导文件（CLAUDE.md /
   AGENTS.md）落盘正确
5. 设置页开关关掉某 agent → HandoffCard 不再列出它
6. 装一个新 agent（不重启 daemon）→ 重开设置页能看到（若装在已有 PATH 目录）

## 附录 A：品牌图标资产（Cursor / OpenCode / Pi）

三家的 SVG 由用户提供。`agent-brand-icons.tsx` 的现有约定：inline SVG（MV3 CSP 禁外链），
按 agent id 前缀键控，generic 线性图标兜底。Claude 用品牌橙硬编码（不随主题翻转），
其余一律 `currentColor` 以便暗色主题可见。

### Cursor —— 原稿即 `currentColor`，单 path，直接嵌

```
viewBox="0 0 24 24"  fill="currentColor"  fillRule="evenodd"
d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"
```

### OpenCode —— 双色，外框改 `currentColor`，内块保留品牌灰

原稿外框是 `#211E1E`（近黑，暗色主题下会隐形）→ 改 `currentColor`。
内块 `#CFCECD` 是品牌灰，浅色/暗色底上都可辨，保留。两个 path 的绘制顺序不能换
（外框靠 nonzero 规则挖空，别加 `fill-rule`）。

```
viewBox="0 0 1024 1024"
<path fill="#CFCECD" d="M716.8 819.2H307.2V409.6h409.6v409.6z" />
<path fill="currentColor" d="M716.8 204.8H307.2v614.4h409.6V204.8z m204.8 819.2H102.4V0h819.2v1024z" />
```

### Pi —— 原稿 `#fff`（为深色底而作），必须改 `currentColor`，保留 `evenodd`

`fill-rule="evenodd"` 是 P 字里那个洞的成因，丢了就变成实心块。

```
viewBox="0 0 800 800"  fill="currentColor"
<path fillRule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z" />
<path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
```

### 实现提示

`AgentBrandIcon` 现在是一串 `if (agentId.startsWith(...))`。id 涨到 8 个之后，
换成显式的「id 前缀 → 渲染函数」查表更稳（同一个文件，十几行），避免将来 `startsWith("pi")`
这类短前缀误伤新 id。
