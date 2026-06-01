<div align="center">
  <img src="public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Chrome 浏览器自动化 Agent —— 通过原生工具调用、Skill 系统、CDP 键盘控制和执行前确认机制，把自然语言任务变成可控的浏览器操作。</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Chrome Web Store 上架" /></a>
  </p>
  <p>
    <a href="README.md">English</a> ·
    <strong>简体中文</strong>
  </p>
  <p>
    <a href="#安装">安装</a> ·
    <a href="#配置">配置</a> ·
    <a href="PRIVACY.md">隐私</a> ·
    <a href="CHANGELOG.md">更新日志</a> ·
    <a href="docs/ROADMAP.md">路线图</a> ·
    <a href="docs/ARCHITECTURE.md">架构</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">项目档案</a>
  </p>
</div>

---

## 为什么是 Pie

Pie 把 Chrome 变成一个浏览器自动化 Agent。用自然语言描述一个任务，LLM
拆解步骤，并通过类型化的工具注册表执行 —— 包括 DOM 动作、跨标签页编排，
以及面向飞书文档、Google Docs 这类不响应标准 DOM 事件的 canvas 编辑器
的 CDP 键盘注入。工作流可以保存为带显式工具白名单的 Skill。每一个不可
逆或跨域操作都会先弹出确认卡片，确保你知情可控。BYOK：把你已有的 API
key 粘进来即可（支持 10 家 LLM 供应商）—— 本地加密保存，无 Pie 后端，
无埋点。

- **原生工具调用驱动的浏览器自动化。** LLM 通过 Anthropic `tool_use` 块或
  OpenAI `function_calling` 操控类型化工具注册表 —— DOM 动作（点击、输入、
  下拉选择、滚动、结构化快照）、跨标签页编排（列表 / 激活 / 关闭 / 分组 /
  移动 / 抓取可读内容），以及（需手动开启的）面向 canvas 编辑器（飞书文档、
  Google Docs 等）的 CDP 键盘注入（`Input.dispatchKeyEvent`、
  `Input.insertText`）。
- **Skill 是一等公民。** Skill 是带工具白名单的提示词模板，对话里输入
  `/skill_name` 即可触发。Agent 也能自己写 Skill —— 但被 8 道能力授权
  不变量约束，无法越权扩张自身权限。
- **执行前先确认。** 每个高危动作（提交表单、敏感字段输入、CDP 原生键盘
  注入、跨域标签页操作、关闭固定标签页）在执行前都会弹出确认卡片，展示
  确切动作、原始参数、影响到的 origin —— 你始终保有知情控制权。
- **多会话持久化。** 对话状态在 Service Worker 重启后仍然可恢复；
  归档会话在存储压力下按 LRU 淘汰，30 天后硬删除。
- **侧边栏，不是弹窗。** Pie 常驻 Chrome 侧边栏，浏览过程中保持打开 ——
  对话、Agent 任务、标签页管理可以同时进行而不丢上下文。
- **BYOK。** 自带 API key（支持 10 家 LLM 供应商）。通过 Web Crypto
  AES-GCM 加密后写入 `chrome.storage.local`。Pie 没有后端、没有埋点、
  不走代理。详见 [PRIVACY.md](PRIVACY.md)。

## 功能

### 页面理解
对当前页面提问。Pie 提取可见文本（凭据字段会被加固清洗），仅把这部分
内容发给 LLM。Prompt 中所有页面片段都用 `<untrusted_*>` 标签包裹，用以
抵御来自页面 DOM 的提示词注入攻击。

### Agent 自动化与工具调用
用自然语言描述一个任务。LLM 拆解步骤，并通过 Pie 的工具注册表执行 ——
全程使用供应商原生的工具调用协议：Claude 用 Anthropic `tool_use`
块，其他供应商走 OpenAI `function_calling`。内置工具集覆盖：

- **DOM 动作** —— 点击、输入、下拉选择、滚动，以及对可交互元素
  （链接、按钮、输入框）的结构化快照
- **跨标签页工具** —— 列表、激活、关闭、分组 / 解组、移动、抓取另一个
  标签页的可读内容
- **CDP 键盘**（默认关闭，需手动开启）—— `Input.dispatchKeyEvent` 与
  `Input.insertText`，用于飞书文档、Google Docs 这类不响应标准 DOM 事件
  的 canvas 编辑器
- **Skill 元工具** —— Agent 可以自行 create / update / delete / list
  自己的 Skill（详见下方 *Skill 系统*）

内置三个跨标签页 Skill：`auto_group_tabs`、`close_duplicate_tabs`、
`close_inactive_tabs`。

### Skill 系统
Skill 是带显式工具白名单的提示词模板。打开 **设置 → Skills** 创建、
编辑、删除你自己的 Skill —— 包括名称、提示模板、参数 JSON Schema，以及
该 Skill 可调用的精确工具集合。在对话框内输入 `/skill_name` 即可运行
任意 Skill。

Agent 自己也能通过 `create_skill` / `update_skill` / `delete_skill` 元工具
创建 Skill —— 适合把模型刚刚走通的工作流捕获下来，下一次会话直接复用。
Agent 创建的 Skill 会被打上 `author='agent'` 标记，首次执行时会触发
一次性确认卡片；模型自创的 Skill 永远不会在下一次执行时被静默运行。

Skill 无法越过自己声明的工具白名单。每次 Skill 写入都会强制执行
8 道能力授权不变量 —— 硬上限（提示模板 ≤ 8 KB、参数 schema ≤ 2 KB）、
禁止嵌套元工具、单设备 1 MB 存储预算、对实时工具注册表做名称校验 ——
失控的 Skill 无法自行扩张权限。

### 高危动作审批
Pie 在每次工具调用执行前都会做风险分类。任何不可逆操作或跨域操作都需要
你先批准一张确认卡片。**高危**触发条件包括：表单提交、向密码 / 支付 /
邮件字段输入、通过 CDP 注入原生键盘事件、关闭固定标签页，以及任何跨域
标签页操作。

确认卡片会展示：

- 工具的精确名称与 Agent 准备传入的原始参数（让你能在执行前发现错误，
  或揪出页面 DOM 里被注入的提示词指令）
- 每个受影响标签页的 origin 与标题；当动作会跨过任务起始时锁定的
  pinned origin 时单独标注
- **Approve / Reject** 按钮对，外加任务级 **Discard** 选项，用于完全
  放弃 Agent 的当前计划

CDP 键盘模拟功能 **默认关闭** —— 必须先在设置里开启才能附加。如果你在
同一个任务里连续拒绝 3 次，Pie 会自动终止任务，避免在你已经否定的计划上
继续烧 token。

### 支持的供应商

| 供应商 | 说明 |
|---|---|
| Anthropic Claude | 原生 API + 原生 `tool_use` |
| OpenAI | OpenAI `function_calling` |
| Gemini | 原生 API |
| OpenRouter | OpenAI 兼容 |
| DeepSeek | Anthropic 兼容 |
| MiniMax | Anthropic 兼容 |
| GLM(智谱) | OpenAI 兼容 |
| Bailian | OpenAI 兼容 |
| Mimo(小米) | Anthropic 兼容 |
| Moonshot(Kimi) | OpenAI 兼容 · 国际区 `api.moonshot.ai` / 中国区 `api.moonshot.cn`（新建实例时选对应条目即选区） |

新增一家供应商只需要一条 registry 条目加一条 host permission。本地
Ollama 见 [路线图](docs/ROADMAP.md)。

## 安装

Pie 提供两种面向终端用户的安装渠道，外加一种源码构建渠道，按需挑选。

需要支持 side panel 的 Chromium 浏览器 —— Chrome 114+、Edge、Brave、
Arc 等均可。

### 方式一 —— Chrome Web Store（推荐）

从 **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)** 安装 —— 点击 **Add to Chrome**，随后将 Pie 钉到工具栏。Chrome 会自动保持更新。

### 方式二 —— GitHub Release zip（解压安装）

适用于不想走 Web Store、但要装同一份产物的用户（如离线、自管或受策略限制的环境）：

1. 从 [Releases 页面](https://github.com/WiseriaAI/pie-ai-agent/releases)
   下载最新的 `pie-x.y.z.zip`
2. 解压到一个会长期保留的目录（Chrome 运行时会从这个目录加载，安装后
   不要删除）
3. 打开 `chrome://extensions`
4. 打开右上角 **开发者模式**
5. 点 **加载已解压的扩展程序**，选择刚才解压出来的目录
6. 把 Pie 钉到工具栏；点击图标即可打开侧边栏

#### 升级而不丢历史数据

Chrome 通过 unpacked 目录的绝对路径计算扩展 ID，而会话 / 加密的 API key /
Skill 都按这个 ID 存在 `chrome.storage.local` 里。要在版本之间保留这些
数据，**必须就地升级** —— 不要把新版 zip 解压到另一个文件夹。

1. 打开 `chrome://extensions`，找到 Pie 卡片，记下它的 unpacked 目录
   路径（卡片下方或 **详细信息 → Source** 里能看到）
2. 删除该目录里的所有文件，但保留目录本身
3. 把新版 `pie-x.y.z.zip` 解压到这个相同目录
4. 点 Pie 卡片上的 **↻ 重新加载** 图标

> ⚠️ 不要点 **移除**。移除会清掉扩展的 `chrome.storage.local`，
> 包括加密的 API key 和聊天记录。如果已经移除了，需要从 Settings 重新
> 填 API key；聊天记录无法恢复。

走 Web Store（方式一）的用户不用管这一节 —— Chrome 自动更新，
数据自动跟着走。

### 方式三 —— 从源码构建（贡献者）

如果你想要 HMR、要发 PR，或者就是不信任预编译产物：

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

把生成的 `dist/` 目录作为已解压扩展加载（步骤 3–6 同上）。日常开发循环
见下方 [开发](#开发)。

## 配置

1. 打开侧边栏，切到 **Settings** 标签
2. 新增一条 provider —— 粘贴 API key，选好模型
3. 切回 **Chat**，发一条消息

你的 key 在写入 `chrome.storage.local` 之前会先被加密。加密所用的密钥在
首次启动时本地生成，永远不会离开你的设备。

## 隐私与安全

- BYOK：API key 永远不离开你的设备，仅作为 `Authorization` 头随直连
  供应商的 API 请求一起发送
- 所有发给 LLM 的页面内容都包裹在 `<untrusted_*>` 标签里，硬抗来自页面
  DOM 的提示词注入
- 跨域标签页动作和高危 DOM 动作都需要明确的确认卡片 —— Pie 在执行前
  把动作内容、目标 origin 一并展示给你
- 无埋点、无统计、无第三方

完整策略：[PRIVACY.md](PRIVACY.md)。

## 开发

```bash
pnpm install
pnpm dev          # Vite 开发服务器，带 HMR
pnpm test         # Vitest，单次运行
pnpm test:watch   # Vitest，监听模式
pnpm build        # 生产构建至 dist/
```

开发时把 `dist/` 当作已解压扩展加载（首次 `pnpm dev` 之后），每次改完
service worker 后到 `chrome://extensions` 点 **重新加载**。

### 技术栈

- Chrome Extension Manifest V3
- React 19 + TypeScript 6
- TailwindCSS 4（Vite 插件，无配置文件）
- Vite 8 + `@crxjs/vite-plugin` 2.4
- pnpm

### 项目结构

| 路径 | 用途 |
|---|---|
| `src/background/` | Service Worker —— 消息路由、Agent loop 派发、保活 |
| `src/sidepanel/` | React 侧边栏 UI（Chat、Settings、会话抽屉） |
| `src/lib/model-router/` | 统一 LLM 接口；按供应商封装流式 + 工具调用 |
| `src/lib/agent/` | ReAct 循环、工具注册表、风险分类器、提示词构造 |
| `src/lib/dom-actions/` | 通过 `executeScript` 注入的自包含 DOM 动作函数 |
| `src/lib/skills/` | Skill 框架：类型、存储、内置 Skill |
| `src/lib/sessions/` | 会话生命周期：持久化、归档、多会话沙箱 |

架构说明与不变量追踪文档放在 `docs/solutions/`。项目的 compound-engineering
说明和贡献者指南见 [`CLAUDE.md`](CLAUDE.md)。

## 路线图

延期里程碑列表见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。要点：

- 通过 Ollama 接入本地模型
- 快捷键
- 按页面 URL 匹配自动触发 Skill
- 操作录制 → 自动生成 Skill

## 版本与发布

Pie 遵循 [Semantic Versioning](https://semver.org)。发布说明见
[CHANGELOG.md](CHANGELOG.md)。

## 许可证

基于 [Apache License, Version 2.0](LICENSE) 开源 —— © 2026 Pie Project Contributors.
